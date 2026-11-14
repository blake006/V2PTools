@echo off
REM ============================================================
REM V2PTools emergency network repair (standalone, no app needed)
REM
REM Use this ONLY if the PC cannot reach the network after a
REM reboot / crash and V2PTools itself will not start.
REM
REM It is deliberately conservative: it does NOT delete a proxy
REM server address that may belong to another tool or a corporate
REM network. It only turns the system proxy switch off, removes
REM a dead local PAC, resets WinHTTP, and clears our owner marker.
REM ============================================================
setlocal EnableDelayedExpansion
chcp 65001 >nul 2>&1
title V2PTools - Emergency Network Repair

set IEKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings

echo.
echo   V2PTools - Emergency Network Repair
echo   ----------------------------------------------
echo.

echo [1/5] Turning off the system proxy switch...
reg add "%IEKEY%" /v ProxyEnable /t REG_DWORD /d 0 /f >nul 2>&1
if errorlevel 1 (echo       FAILED - try running as administrator) else (echo       OK)

echo [2/5] Removing a dead local PAC auto-config URL if present...
set PACVAL=
for /f "tokens=2*" %%A in ('reg query "%IEKEY%" /v AutoConfigURL 2^>nul') do set PACVAL=%%B
if defined PACVAL (
  echo       %PACVAL% | findstr /i "127.0.0.1 localhost" >nul 2>&1
  if not errorlevel 1 (
    reg delete "%IEKEY%" /v AutoConfigURL /f >nul 2>&1
    echo       Removed local PAC
  ) else (
    echo       Kept non-local PAC ^(may belong to your network^)
  )
) else (
  echo       No PAC configured
)

echo [3/5] Resetting WinHTTP proxy ^(system services^)...
netsh winhttp reset proxy >nul 2>&1
if errorlevel 1 (echo       Skipped - needs administrator rights) else (echo       OK)

echo [4/5] Clearing V2PTools owner marker...
reg delete "HKCU\Software\V2PTools\ProxyOwner" /f >nul 2>&1
echo       OK

echo [5/5] Flushing DNS cache...
ipconfig /flushdns >nul 2>&1
echo       OK

echo.
echo   Done. Your PC should now use a direct connection.
echo   Open V2PTools and use "One-click network repair" for a
echo   full check, then enable the proxy again.
echo.
echo   NOTE: if ProxyOverride still contains ^<^-loopback^>,
echo         use the in-app repair to clean it safely.
echo.
pause
endlocal
