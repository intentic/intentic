@echo off
rem `intentic .` from cmd or PowerShell: opens the folder (or document) in the Intentic app, the way `code .` opens
rem VS Code. It lives in the app's `bin` folder, which the installer puts on the user's PATH; `intentic` beside it is
rem the same command for WSL and Git Bash.
rem
rem The app takes the paths it opens as arguments (src/local.rs `open_args`) and reads a relative one against the
rem folder it was started in, at a cold start or handed to the running app.
rem
rem It is started by PowerShell's Start-Process, not by cmd's `start`, and not run from here directly: a batch file
rem waits for what it runs, and `start` hands the app every handle this terminal can pass on, the output the caller
rem redirected or captured included. The app lives on in the tray, so it would hold that file or pipe for as long as it
rem runs, and `$x = intentic .`, `intentic . | Out-Null` or a tool reading the output would wait for it to quit.
rem Start-Process passes none of them and returns at once. The arguments go as they were typed, through a variable,
rem so no quoting here can change them; `start` is what is left where PowerShell is missing or blocked, and what
rem PowerShell said about that is not shown, since the app still opens.
rem
rem cmd.exe cannot stand in a \\server\share or \\wsl.localhost folder: started in one (PowerShell sitting in a WSL
rem home), it says "UNC paths are not supported" and moves to the Windows folder, so `intentic .` would open
rem C:\Windows. That case is refused, since a relative path there no longer names what the caller meant.
setlocal
set "intentic_app=%~dp0..\intentic-desktop.exe"
if not exist "%intentic_app%" (
    echo intentic: the Intentic app is not where this command expects it ^(%~dp0..^). Reinstall Intentic. 1>&2
    exit /b 1
)
if /i "%CD%"=="%SystemRoot%" if not "%~1"=="" (
    set "intentic_first=%~1"
    call :relative && (
        echo intentic: this terminal is in a network or WSL folder, which cmd.exe cannot open, so "%~1" would mean %SystemRoot%. Run intentic from WSL there, or give the full path. 1>&2
        exit /b 1
    )
)
rem The escaped outer quotes leave the quotes the caller typed in charge: `intentic "R&D (copy)"` stays one quoted
rem argument here, where `set "intentic_args=%*"` would end the quote early and run `D (copy)` as a command.
set ^"intentic_args=%*^"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "if ($env:intentic_args) { Start-Process -FilePath $env:intentic_app -ArgumentList $env:intentic_args } else { Start-Process -FilePath $env:intentic_app }" <nul 2>nul && exit /b 0
start "" "%intentic_app%" %* <nul >nul 2>nul
exit /b 0

rem Whether the first argument is a relative path: not a flag, a link, a drive path or a \\ path. Read with delayed
rem expansion, so an `&` or a `)` in a folder's name is text and not cmd syntax.
:relative
setlocal EnableDelayedExpansion
if "!intentic_first:~0,1!"=="-" exit /b 1
if "!intentic_first:~1,1!"==":" exit /b 1
if "!intentic_first:~0,2!"=="\\" exit /b 1
if not "!intentic_first:://=!"=="!intentic_first!" exit /b 1
exit /b 0
