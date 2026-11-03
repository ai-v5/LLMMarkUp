; SPDX-License-Identifier: AGPL-3.0-only
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "nsProcess.nsh"

Name "LLMMarkUp"
InstallDir "$LOCALAPPDATA\Programs\LLMMarkUp"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show
Var TestRegistryHandle

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${PROJECT_DIR}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro addLangs

!macro CheckTestIsolation
  ReadEnvStr $R2 "LLMMARKUP_TEST_DATA"
  ${If} $R2 != ""
    GetFullPathName $R2 "$R2"
    ReadEnvStr $R3 "TEMP"
    GetFullPathName $R3 "$R3"
    StrCpy $R4 "$R2\temp"
    GetFullPathName $R4 "$R4"
    ${If} $R3 != $R4
      SetErrorLevel 2
      Quit
    ${EndIf}
    ReadEnvStr $R3 "TMP"
    GetFullPathName $R3 "$R3"
    ${If} $R3 != $R4
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $R4 "$R2\install"
    GetFullPathName $R4 "$R4"
    GetFullPathName $R3 "$INSTDIR"
    ${If} $R3 != $R4
      StrCpy $R4 "$R2\legacy-install"
      GetFullPathName $R4 "$R4"
      ${If} $R3 != $R4
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Function .onInit
  System::Call 'kernel32::CreateMutex(p 0, i 1, t "${APP_GUID}")?e'
  Pop $0
  ${If} $0 == 183
    SetErrorLevel 2
    Quit
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONEXCLAMATION "此安装包需要 64 位 Windows。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadEnvStr $0 "LLMMARKUP_TEST_DATA"
  ${If} $0 != ""
    StrCpy $INSTDIR "$0\install"
    ReadEnvStr $1 "LLMMARKUP_TEST_TARGET"
    ${If} $1 != ""
      StrCpy $INSTDIR $1
    ${EndIf}
    !insertmacro CheckTestIsolation
    System::Call 'advapi32::RegLoadAppKeyW(w "$R2\synthetic-registry.dat", *p .r5, i 0xF003F, i 0, i 0)i.r6'
    ${If} $6 != 0
    ${OrIf} $5 == 0
      SetErrorLevel 2
      Quit
    ${EndIf}
    StrCpy $TestRegistryHandle $5
    System::Call 'advapi32::RegOverridePredefKey(p 0x80000001, p r5)i.r6'
    ${If} $6 != 0
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  SetRegView 64
  ReadRegStr $0 HKCU "Software\${APP_GUID}" "PendingInstallLocation"
  ${If} $0 != ""
    IfFileExists "$0\.llmmarkup-pending.json" +2
      StrCpy $0 ""
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\${APP_GUID}" "InstallLocation"
  ${EndIf}
    ${If} $0 == ""
      ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "UninstallString"
      StrCpy $2 $1 1
      ${If} $2 == '"'
        StrLen $3 $1
        StrCpy $4 1
        ${DoWhile} $4 < $3
          StrCpy $2 $1 1 $4
          ${If} $2 == '"'
            ${Break}
          ${EndIf}
          IntOp $4 $4 + 1
        ${Loop}
        ${If} $4 < $3
          IntOp $4 $4 - 1
          StrCpy $1 $1 $4 1
          ${GetFileName} $1 $2
          ${If} $2 == "Uninstall LLMMarkUp.exe"
          ${OrIf} $2 == "Uninstall MDPPT Studio.exe"
            ${GetParent} $1 $0
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${If} $0 != ""
    StrCpy $INSTDIR "$0"
  ${EndIf}
  !insertmacro CheckTestIsolation
FunctionEnd

Section "Install"
  !insertmacro CheckTestIsolation
  !insertmacro GuardRunningApplications "LLMMarkUp.exe" "MDPPT Studio.exe"
  InitPluginsDir
  File /oname=$PLUGINSDIR\installer-core.ps1 "${PROJECT_DIR}\scripts\installer-core.ps1"
  File /oname=$PLUGINSDIR\safe-migrate.ps1 "${PROJECT_DIR}\scripts\safe-migrate.ps1"
  File /oname=$PLUGINSDIR\safe-uninstall.ps1 "${PROJECT_DIR}\scripts\safe-uninstall.ps1"
  File /oname=$PLUGINSDIR\payload.7z "${APP_64}"
  WriteUninstaller "$PLUGINSDIR\llmmarkup-uninstall.exe"
  CreateDirectory "$PLUGINSDIR\payload"
  SetOutPath "$PLUGINSDIR\payload"
  Nsis7z::Extract "$PLUGINSDIR\payload.7z"
  IfFileExists "$PLUGINSDIR\payload\LLMMarkUp.exe" +4
    MessageBox MB_OK|MB_ICONEXCLAMATION "无法解压安装文件。" /SD IDOK
    SetErrorLevel 2
    Quit
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-core.ps1" -Mode Install -InstallRoot "$INSTDIR" -AppGuid "${APP_GUID}" -Version "${VERSION}" -Payload "$PLUGINSDIR\payload" -UninstallerPath "$PLUGINSDIR\llmmarkup-uninstall.exe" -HelperDirectory "$PLUGINSDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "安装未完成。请保留安装目录和备份后重试。$\r$\n$1" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetErrorLevel 0
SectionEnd

Function un.onInit
  System::Call 'kernel32::CreateMutex(p 0, i 1, t "${APP_GUID}")?e'
  Pop $0
  ${If} $0 == 183
    SetErrorLevel 2
    Quit
  ${EndIf}
  !insertmacro CheckTestIsolation
FunctionEnd

Section "Uninstall"
  !insertmacro CheckTestIsolation
  !insertmacro GuardRunningApplications "LLMMarkUp.exe" "MDPPT Studio.exe"
  InitPluginsDir
  File /oname=$PLUGINSDIR\installer-core.ps1 "${PROJECT_DIR}\scripts\installer-core.ps1"
  File /oname=$PLUGINSDIR\safe-migrate.ps1 "${PROJECT_DIR}\scripts\safe-migrate.ps1"
  File /oname=$PLUGINSDIR\safe-uninstall.ps1 "${PROJECT_DIR}\scripts\safe-uninstall.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\installer-core.ps1" -Mode Uninstall -InstallRoot "$INSTDIR" -AppGuid "${APP_GUID}" -Version "${VERSION}" -HelperDirectory "$PLUGINSDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "卸载未完成，未识别或修改过的文件已保留。$\r$\n$1" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  SetErrorLevel 0
SectionEnd
