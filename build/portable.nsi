; V2PTools 单文件便携版启动器
; 编译: npm run dist:exe （版本号由 scripts/build-portable.js 从 package.json 同步写入）
; 手动: makensis build/portable.nsi

Unicode true
!define APPNAME "V2PTools"
!define VERSION "1.4.6"

Name "${APPNAME}"
OutFile "..\dist\${APPNAME}-${VERSION}-win-x64-portable.exe"
Icon "icon.ico"

SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompress force
SetOverwrite on

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "V2PTools"
VIAddVersionKey "CompanyName" "${APPNAME}"
VIAddVersionKey "LegalCopyright" "Copyright (c) 2026 ${APPNAME}"
VIAddVersionKey "FileVersion" "${VERSION}.0"
VIAddVersionKey "ProductVersion" "${VERSION}"

Section "Main"
  SetOutPath "$TEMP\${APPNAME}-${VERSION}"
  File /r "..\dist\win-unpacked\*.*"
  ExecWait '"$TEMP\${APPNAME}-${VERSION}\${APPNAME}.exe"'
SectionEnd
