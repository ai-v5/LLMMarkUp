# LLMMarkUp

<img src="assets/studio.png" width="96" alt="LLMMarkUp">

离线 Windows Markdown 工作台：左侧浏览目录，中间编辑源码，右侧实时预览。

## 功能

- 多文件标签：切换保留草稿、撤销与滚动位置；关闭标签、切换目录和退出保护相关未保存内容。
- 目录懒加载，支持创建根目录和子目录；两处分隔条可拖拽调整。
- 最近文件/目录，重启恢复有效目录、标签与活动项；记住全局明暗与预览比例。
- 目录与编辑区共享明暗，预览独立明暗；预览缩放 50%～150%，支持编辑驱动的同步滚动。
- CodeMirror 编辑，markdown-it 预览，KaTeX 离线复杂公式，包括矩阵、多行对齐、分段、积分、求和。
- 保存保留 UTF-8 BOM 与 LF/CRLF，外部修改冲突时拒绝覆盖。

## 开发和构建

Windows x64，Node.js 22.12+：

```powershell
npm ci
npm start
npm test
npm run test:e2e
npm run dist
```

安装包位于 `outputs/installers/LLMMarkUp-0.4.0-Setup.exe`。安装后不需要 Python、Node 或本地 Web 服务。构建显式使用 `--publish never`，不会上传产物或创建 Release；当前安装包未签名。

本机开发交付使用 `npm run dist:local`：核验安装归属、正常请求关闭、原位安装、校验版本和应用包 hash 后重新打开。出现未保存提示时须由用户处理，脚本不会强杀。也可用 `powershell -File install-local.ps1 -InstallDirectory <目标目录> -Launch` 指定位置。首次安装默认当前用户 Programs 目录。

仅重跑安装版测试：

```powershell
$env:LLMMARKUP_TEST_EXE = '<安装目录>\LLMMarkUp.exe'
node --test tests/e2e.cjs
```

## 使用

`Ctrl+O` 打开目录，左上角“打开”含最近文件和目录；点击文件树打开标签。`Ctrl+S` 保存、`Ctrl+W` 关闭标签、`Ctrl+N` 新建 Markdown、`Ctrl+Shift+N` 新建目录、`Ctrl+F` 查找、`Ctrl+R` 重新读取磁盘。最近文件/目录各保留 12 项，最多同时打开 50 个标签。

全局配置位于 Electron 标准 `userData/studio-session.json`，仅保存打开记录和界面状态，不保存未保存正文。首次从早期 MDPPT Studio 升级时，仅在新配置不存在的情况下读取既定旧配置，保留旧文件并迁移有效字段；新配置已存在时不再读取旧配置。Windows 安装身份沿用既有升级标识，界面、EXE、快捷方式和新安装目录使用 LLMMarkUp。

支持不超过 2 MiB 的 UTF-8 文档；混合换行、其他编码、目录越界和子路径中的符号链接/联接明确拒绝。公式支持 `$...$`、`\(...\)`、`$$...$$`、`\[...\]` 和 `math` 围栏，限于 KaTeX 支持集。

## 边界

应用无账号、遥测、模型 API、云同步或联网下载更新。文档 HTML 不执行，图片显示占位，链接不可导航；不允许文档发起网络请求或读取任意本地文件。未实现图片、Mermaid、崩溃草稿恢复、删除/重命名及多人协作。

当前验证面向 Windows x64；自动化不能代替真人输入法、不同 Windows 版本、SmartScreen 和签名验证。配置迁移测试仅使用合成旧配置，不读取用户资料。

## 开源与贡献

项目自有代码和原创图标采用 [GNU AGPL v3，仅第 3 版](LICENSE)（`AGPL-3.0-only`），第三方组件保留自身许可，KaTeX 字体保留 [OFL-1.1](licenses/KaTeX-FONTS-OFL.txt)，参见 [NOTICE](NOTICE)。对应源码、构建脚本和依赖锁文件均在本仓库；“帮助 → 关于 LLMMarkUp”可查看版本、许可和源码地址。

欢迎通过 Issue 描述复现步骤和预期行为，通过 PR 提交范围明确的修改。请只使用合成样例，执行相关测试，不提交用户文档、配置、凭据、日志或安装包。安全问题请使用仓库的私密漏洞报告渠道，勿在公开 Issue 发布有效凭据或未修复漏洞细节。

## 当前验证

0.4.0 在 Windows x64 上验证：18 项文件/会话/渲染测试通过，开发窗口和实际安装 EXE 各通过 2 项端到端测试，包括完整编辑保存闭环和合成旧配置迁移。已完成既有安装的原位升级、配置保留和安装包版本/内容 hash 核验。当前依赖锁文件审计为 0 项已知漏洞；这不保证未来没有漏洞。真人输入法、多 Windows 版本、代码签名与 SmartScreen 未验证。
