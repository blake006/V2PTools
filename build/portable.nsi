; V2PTools 单文件便携版启动器
; 编译: makensis build/portable.nsi

Unicode true
Name "V2PTools"
OutFile "..\dist\V2PTools-1.0.0-win-x64-portable.exe"
Icon "icon.ico"

SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompress force
SetOverwrite on

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "V2PTools"
VIAddVersionKey "FileDescription" "代理池体检 + 系统代理工具"
VIAddVersionKey "CompanyName" "V2PTools"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 V2PTools"
VIAddVersionKey "FileVersion" "1.0.0.0"
VIAddVersionKey "ProductVersion" "1.0.0"

Section "Main"
  SetOutPath "$TEMP\V2PTools-1.0.0"
  File /r "..\dist\win-unpacked\*.*"
  ExecWait '"$TEMP\V2PTools-1.0.0\V2PTools.exe"'
SectionEnd
