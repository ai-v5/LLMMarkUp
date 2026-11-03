; SPDX-License-Identifier: AGPL-3.0-only
!macro GuardRunningApplications CURRENT_EXECUTABLE LEGACY_EXECUTABLE
  ${nsProcess::FindProcess} "${CURRENT_EXECUTABLE}" $R0
  ${nsProcess::FindProcess} "${LEGACY_EXECUTABLE}" $R1
  ${nsProcess::Unload}
  ${If} $R0 != 603
  ${OrIf} $R1 != 603
    MessageBox MB_OK|MB_ICONEXCLAMATION "请先保存并关闭 LLMMarkUp 或旧版 MDPPT Studio，再重新运行安装或卸载程序。" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !insertmacro GuardRunningApplications "${APP_EXECUTABLE_FILENAME}" "MDPPT Studio.exe"
!macroend

!macro customInstall
  WriteRegStr HKCU "Software\Classes\LLMMarkUp.Markdown" "" "Markdown document"
  WriteRegStr HKCU "Software\Classes\LLMMarkUp.Markdown\Application" "ApplicationName" "LLMMarkUp"
  WriteRegStr HKCU "Software\Classes\LLMMarkUp.Markdown\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\LLMMarkUp.Markdown\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "LLMMarkUp.Markdown" ""
  WriteRegStr HKCU "Software\Classes\.markdown\OpenWithProgids" "LLMMarkUp.Markdown" ""
  WriteRegStr HKCU "Software\Classes\Applications\LLMMarkUp.exe" "FriendlyAppName" "LLMMarkUp"
  WriteRegStr HKCU "Software\Classes\Applications\LLMMarkUp.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Classes\Applications\LLMMarkUp.exe\SupportedTypes" ".markdown" ""
  WriteRegStr HKCU "Software\Classes\Applications\LLMMarkUp.exe\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Classes\LLMMarkUp.Markdown\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "LLMMarkUp.Markdown"
    DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "LLMMarkUp.Markdown"
    DeleteRegKey HKCU "Software\Classes\LLMMarkUp.Markdown"
  ${EndIf}
  ReadRegStr $0 HKCU "Software\Classes\Applications\LLMMarkUp.exe\shell\open\command" ""
  ${If} $0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    DeleteRegKey HKCU "Software\Classes\Applications\LLMMarkUp.exe"
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
