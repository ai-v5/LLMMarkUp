// SPDX-License-Identifier: AGPL-3.0-only
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

internal static class Launcher {
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] private struct FileInfo {
        public uint Attributes; public FileTime Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct StartupInfo {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public ushort ShowWindow, Reserved2; public IntPtr ReservedPtr, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr GetCommandLineW();
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] private static extern int RegLoadAppKey(string file, out SafeRegistryHandle key, uint access, uint options, uint reserved);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int MessageBoxW(IntPtr window, string text, string caption, uint type);

    private static SafeFileHandle OpenPath(string path, bool directory) {
        uint access = directory ? 128u : 0x80000000u;
        uint share = directory ? 3u : 1u;
        uint flags = directory ? 0x02200000u : 0x00200080u;
        SafeFileHandle handle = CreateFile(path, access, share, IntPtr.Zero, 3, flags, IntPtr.Zero);
        if (handle.IsInvalid) throw new InvalidOperationException("安装文件不可用或正在被修改。");
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x400) != 0 || (((info.Attributes & 0x10) != 0) != directory)) {
            handle.Dispose(); throw new InvalidOperationException("安装路径包含不支持的链接或文件类型。");
        }
        return handle;
    }
    private static string FinalPath(SafeFileHandle handle) {
        StringBuilder result = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, result, (uint)result.Capacity, 0);
        if (length == 0 || length >= result.Capacity) throw new InvalidOperationException("无法验证安装路径。");
        return result.ToString().TrimEnd('\\');
    }
    private static bool SameFile(SafeFileHandle left, SafeFileHandle right) {
        FileInfo a, b;
        if (!GetFileInformationByHandle(left, out a) || !GetFileInformationByHandle(right, out b)) throw new InvalidOperationException("无法验证安装文件身份。");
        return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow;
    }
    private static string Hash(Stream stream) {
        stream.Position = 0;
        using (SHA256 algorithm = SHA256.Create()) {
            byte[] bytes = algorithm.ComputeHash(stream);
            StringBuilder result = new StringBuilder(64);
            foreach (byte value in bytes) result.Append(value.ToString("x2"));
            stream.Position = 0;
            return result.ToString();
        }
    }
    private static string RequiredString(IDictionary<string,object> value, string name) {
        object item;
        if (!value.TryGetValue(name, out item) || !(item is string) || String.IsNullOrWhiteSpace((string)item)) throw new InvalidOperationException("安装记录不完整。");
        return (string)item;
    }
    private static IDictionary<string,object> Parse(byte[] bytes) {
        if (bytes.Length == 0 || bytes.Length > 16 * 1024 * 1024) throw new InvalidOperationException("安装记录大小无效。");
        string text = new UTF8Encoding(false, true).GetString(bytes);
        JavaScriptSerializer serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = 16 * 1024 * 1024;
        IDictionary<string,object> result = serializer.DeserializeObject(text) as IDictionary<string,object>;
        if (result == null) throw new InvalidOperationException("安装记录格式无效。");
        return result;
    }
    private static byte[] ReadAll(FileStream stream, int maximum) {
        if (stream.Length < 0 || stream.Length > maximum) throw new InvalidOperationException("安装记录大小无效。");
        byte[] bytes = new byte[(int)stream.Length]; int offset = 0; stream.Position = 0;
        while (offset < bytes.Length) { int count = stream.Read(bytes, offset, bytes.Length-offset); if (count == 0) throw new EndOfStreamException(); offset += count; }
        stream.Position = 0; return bytes;
    }
    private static RegistryKey OpenRegistry() {
        string testRoot = Environment.GetEnvironmentVariable("LLMMARKUP_TEST_DATA");
        if (String.IsNullOrEmpty(testRoot)) return Registry.CurrentUser;
        string hive = Path.Combine(Path.GetFullPath(testRoot), "synthetic-registry.dat");
        if (!File.Exists(hive)) throw new InvalidOperationException("隔离测试注册表不可用。");
        SafeRegistryHandle handle;
        if (RegLoadAppKey(hive, out handle, 0x20019, 0, 0) != 0 || handle.IsInvalid) throw new InvalidOperationException("无法打开隔离测试注册表。");
        return RegistryKey.FromHandle(handle);
    }
    private static string ArgumentTail() {
        string command = Marshal.PtrToStringUni(GetCommandLineW());
        if (String.IsNullOrEmpty(command)) throw new InvalidOperationException("无法读取启动参数。");
        int i = 0;
        while (i < command.Length && (command[i] == ' ' || command[i] == '\t')) i++;
        if (i < command.Length && command[i] == '"') {
            i++;
            while (i < command.Length && command[i] != '"') i++;
            if (i == command.Length) throw new InvalidOperationException("启动参数格式无效。");
            i++;
        } else while (i < command.Length && command[i] != ' ' && command[i] != '\t') i++;
        return command.Substring(i);
    }
    private static void CheckOtherApplications(string target, SafeFileHandle targetHandle) {
        int own = Process.GetCurrentProcess().Id;
        foreach (string name in new[] { "LLMMarkUp", "MDPPT Studio" }) {
            foreach (Process process in Process.GetProcessesByName(name)) using (process) {
                if (process.Id == own || process.HasExited) continue;
                try {
                    string executable = process.MainModule.FileName;
                    using (SafeFileHandle other = OpenPath(executable, false)) {
                        if (!SameFile(other, targetHandle)) throw new InvalidOperationException("请先保存并关闭其他版本的 LLMMarkUp 或 MDPPT Studio。");
                    }
                } catch (InvalidOperationException) { throw; }
                catch { throw new InvalidOperationException("无法确认其他编辑器进程的状态，请先关闭它们。"); }
            }
        }
    }
    private static int Run() {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string root = Path.GetDirectoryName(Path.GetFullPath(self));
        string installId, manifestHash;
        using (RegistryKey baseKey = OpenRegistry()) using (RegistryKey key = baseKey.OpenSubKey(@"Software\" + LauncherBuildInfo.AppGuid, false)) {
            if (key == null) throw new InvalidOperationException("找不到安装记录。");
            installId = key.GetValue("CurrentInstallId") as string;
            manifestHash = key.GetValue("CurrentManifestSha256") as string;
            string registeredRoot = key.GetValue("InstallLocation") as string;
            Guid parsed;
            if (!Guid.TryParseExact(installId, "D", out parsed) || String.IsNullOrEmpty(manifestHash) || manifestHash.Length != 64 || String.IsNullOrEmpty(registeredRoot)) throw new InvalidOperationException("安装记录无效。");
            using (SafeFileHandle actualRoot = OpenPath(root, true)) using (SafeFileHandle expectedRoot = OpenPath(Path.GetFullPath(registeredRoot), true)) {
                if (!SameFile(actualRoot, expectedRoot)) throw new InvalidOperationException("启动入口与安装记录不一致。");
            }
        }
        string versions = Path.Combine(root, ".llmmarkup-versions");
        string runtime = Path.Combine(versions, installId);
        string executable = Path.Combine(runtime, "LLMMarkUp.exe");
        using (SafeFileHandle rootHandle = OpenPath(root, true)) using (SafeFileHandle versionsHandle = OpenPath(versions, true)) using (SafeFileHandle runtimeHandle = OpenPath(runtime, true)) {
            string rootPrefix = FinalPath(rootHandle) + "\\";
            string versionsPrefix = FinalPath(versionsHandle) + "\\";
            string runtimePrefix = FinalPath(runtimeHandle) + "\\";
            if (!versionsPrefix.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) || !runtimePrefix.StartsWith(versionsPrefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("安装目录不在预期位置。");
            using (FileStream marker = new FileStream(OpenPath(Path.Combine(runtime, ".llmmarkup-owned.json"), false), FileAccess.Read))
            using (FileStream manifest = new FileStream(OpenPath(Path.Combine(runtime, ".llmmarkup-manifest.json"), false), FileAccess.Read))
            using (FileStream target = new FileStream(OpenPath(executable, false), FileAccess.Read))
            using (FileStream selfStream = new FileStream(OpenPath(self, false), FileAccess.Read)) {
                foreach (FileStream stream in new[] { marker, manifest, target }) if (!FinalPath(stream.SafeFileHandle).StartsWith(runtimePrefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("安装文件不在预期位置。");
                if (SameFile(selfStream.SafeFileHandle, target.SafeFileHandle) || Hash(selfStream) == Hash(target)) throw new InvalidOperationException("启动目标无效，已停止以避免循环启动。");
                byte[] manifestBytes = ReadAll(manifest, 16 * 1024 * 1024);
                IDictionary<string,object> ownership = Parse(ReadAll(marker, 1024 * 1024));
                if (Convert.ToInt32(ownership["schema"]) != 1 || RequiredString(ownership, "product") != "llmmarkup" || !String.Equals(RequiredString(ownership, "installId"), installId, StringComparison.OrdinalIgnoreCase) || !String.Equals(RequiredString(ownership, "manifestSha256"), manifestHash, StringComparison.OrdinalIgnoreCase) || !String.Equals(Hash(manifest), manifestHash, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("安装归属验证失败。");
                IDictionary<string,object> content = Parse(manifestBytes);
                if (Convert.ToInt32(content["schema"]) != 1 || RequiredString(content, "product") != "llmmarkup") throw new InvalidOperationException("安装清单无效。");
                IEnumerable files = content["files"] as IEnumerable; string expected = null; int count = 0;
                if (files == null) throw new InvalidOperationException("安装清单无效。");
                foreach (object value in files) {
                    IDictionary<string,object> item = value as IDictionary<string,object>;
                    if (item != null && String.Equals(RequiredString(item, "path"), "LLMMarkUp.exe", StringComparison.OrdinalIgnoreCase)) { expected = RequiredString(item, "sha256"); count++; }
                }
                if (count != 1 || !String.Equals(Hash(target), expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("应用文件已更改，无法安全启动。");
                CheckOtherApplications(executable, target.SafeFileHandle);
                StartupInfo startup = new StartupInfo(); startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo)); ProcessInfo child;
                StringBuilder command = new StringBuilder("\"" + executable + "\"" + ArgumentTail());
                if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref startup, out child)) throw new InvalidOperationException("无法启动应用，请检查安装文件。");
                CloseHandle(child.Thread); CloseHandle(child.Process);
            }
        }
        return 0;
    }
    private static int Main() {
        try { return Run(); }
        catch (Exception error) {
            if (String.IsNullOrEmpty(Environment.GetEnvironmentVariable("LLMMARKUP_TEST_DATA"))) MessageBoxW(IntPtr.Zero, error.Message, "LLMMarkUp", 0x10);
            return 2;
        }
    }
}
