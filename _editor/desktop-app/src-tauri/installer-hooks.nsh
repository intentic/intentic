; WHOSE INSTALLER THIS IS, SAID ON THE INSTALLER.
;
; MUI stamps a footer across the bottom of every page of the wizard and, left alone, fills it with its own
; name and build: a first-run install of this product spent five screens captioned
; "Nullsoft Install System v3.08-3+deb12u1", with NSIS's own icon in the title bar and its stock artwork on the
; first and last page. The user is being asked to run an UNSIGNED binary they downloaded, the one moment in
; onboarding where they are looking for a reason to trust or distrust what is on screen, and the only proper noun
; on the window was a build toolchain they have never heard of. It reads as somebody else's software.
;
; None of that is set from here. Tauri's template writes `BrandingText "${COPYRIGHT}"` AFTER including this file,
; and an empty BrandingText is NSIS's "use the default", so a `!define MUI_BRANDINGTEXT` here changed nothing: the
; 1.332.0 installer still said "Nullsoft Install System v3.11-1" (2026-10-12). The footer is `bundle.copyright` in
; tauri.conf.json, and the icon and the side artwork are its `bundle.windows.nsis` `installerIcon`,
; `uninstallerIcon` and `sidebarImage` (icons/installer-sidebar.bmp, 164x314, the app's canvas and its mark).

; Whether the machine agent is still on this PC once the uninstall hook has asked about it (1) or not (0): the last
; page says what stays, and the agent is part of that only when it stayed. Declared here, at the top level, because
; Tauri includes this file there and a Var cannot be declared inside a section.
Var IntenticAgentKept
; Whether this uninstall is the first half of a reinstall (1): see AN UNINSTALL AN INSTALL IS ABOUT TO UNDO, below.
Var IntenticReinstall

; KillProcessCurrentUser calls TerminateProcess without waiting for it to finish. A fixed sleep can leave Tauri's
; running-app check racing that exit: a silent abort then leaves both the uninstall entry and CLI PATH behind.
; Wait for this user's app and sidecar to disappear before the check and file removal, on install and uninstall.
!macro INTENTIC_STOP_PROCESSES
  Push $0
  Push $1
  Push $2
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  nsis_tauri_utils::KillProcessCurrentUser "intentic-files.exe"
  Pop $0
  StrCpy $1 0
  ${Do}
    nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $0
    nsis_tauri_utils::FindProcessCurrentUser "intentic-files.exe"
    Pop $2
    ${If} $0 = 1
    ${AndIf} $2 = 1
      ${ExitDo}
    ${EndIf}
    IntOp $1 $1 + 1
    ${If} $1 >= 60
      DetailPrint "Intentic is still closing; checking whether Windows can finish closing it."
      ${ExitDo}
    ${EndIf}
    Sleep 250
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
!macroend

; Temporary CI trace for the silent uninstall's early return.
!macro INTENTIC_UNINSTALL_TRACE TEXT
  Push $9
  FileOpen $9 "$TEMP\intentic-uninstall-trace.log" a
  FileWrite $9 "${TEXT}$\r$\n"
  FileClose $9
  Pop $9
!macroend

; WHY AN UNINSTALL HOOK AT ALL — this app is meant to be running when you uninstall it.
;
; The tray is where Intentic lives once its window is closed (windows.rs, `apply_close`), so the ordinary
; state at uninstall time is "running, with nothing on screen". Tauri's uninstaller meets that with a
; MessageBox — "Intentic is running. Click OK to kill it" — which is a prompt about the app's own design,
; asked of someone who already told the machine to remove it, and it reads as the uninstaller having found
; something wrong. Answering it is the only thing the invisible process ever asked of anyone.
;
; installer.nsi inserts this hook FIRST in `Section Uninstall`, ahead of its own `CheckIfAppIsRunning` — so
; ending the app here means that check finds nothing and never asks. If the kill fails, the check still runs
; and still prompts, which is the right fallback: an uninstaller that cannot close the app should say so.
;
; `CurrentUser` matches the check's own choice under `installMode: currentUser` — the process to end is this
; user's, not every user's on the machine.
;
; The file server goes too (intentic-files.exe, src/sidecar.rs). It ends by itself once the app's pipe closes, but only
; after it has let go of its office editor, and until then it holds its own file open: the uninstaller's Delete of it
; failed on a slow exit and left the binary behind (2026-10-05). It is killed by name for the same reason as the app.
;
; WHAT AN UNINSTALL LEFT BEHIND, and what it still leaves (2026-10-05). The app is one part of what a setup put on this
; PC, and the uninstaller used to remove that part alone:
;   - the machine agent (~/.intentic/machine), whose keeper starts Docker Desktop at every sign-in to keep sandboxes up.
;     It is ASKED about, not removed unasked: somebody may use it without the app (a terminal setup, a device paired
;     from the workspace). Yes runs `intentic-machine uninstall`, which removes this PC's links, sync pairings and
;     login entry and never a container: it has no flag about sandboxes because it touches none, which is the rule
;     (a container is never deleted silently). Never asked on an update or a passive uninstall, and a silent one
;     answers no.
;   - the platform session, in the webview's cookie store (`$LOCALAPPDATA\<identifier>\EBWebView`), which stayed signed
;     in unless "Delete app data" was ticked. The app's own sign-out (account.rs `signed_off`) deletes the session
;     cookie and empties roster.json; the uninstaller cannot reach the platform with a cookie Chromium keeps
;     encrypted, so it does the local half: the cookie files and the account's name go. Tried a few times, since the
;     webview's own processes outlive the app by a moment and hold the files until they exit.
;   - the sandboxes, their data, `ic` and its PATH entry, and the run logs stay, and the last page says so (below):
;     the sandboxes are the reader's work, and `ic` is how they are removed.
;
; AN UNINSTALL AN INSTALL IS ABOUT TO UNDO (2026-10-15). Running a newer setup by hand over an installed copy shows
; Tauri's reinstall page, whose preselected answer is "Uninstall before installing". That runs THIS uninstaller, without
; `/UPDATE` (only the background updater passes it, and the updater never uninstalls at all), so every guard above read
; it as somebody removing Intentic: it asked "Also remove the Intentic machine agent from this PC?" in the middle of an
; upgrade. A Yes ran `intentic-machine uninstall`, which drops every sandbox link and sync pairing the PC holds; one PC
; lost its link to the sandbox it hosted that way and sat disconnected for two days, while the app it had just updated
; worked fine. It also signed the reader out and unpinned their shortcuts, all for a copy the install re-creates a
; second later.
; The installer runs the old uninstaller IN PLACE (`uninstall.exe _?=<dir>`); a real uninstall, from Settings, the
; Start menu or winget, always runs from a copy NSIS makes in %TEMP%. So an uninstaller standing beside the app's own
; binary is the first half of a reinstall, and it is treated as the update it is: nothing about the agent is asked,
; nobody is signed out, and Tauri's own section keeps the shortcuts and the start-at-login value. The one exception is
; a reader who ticked "Delete app data" on the uninstaller's page: they asked for a clean slate, and get Tauri's full
; removal of the app's own files, but still not a question about the agent, which is no part of the app's data.
!macro NSIS_HOOK_PREUNINSTALL
  Delete "$TEMP\intentic-uninstall-trace.log"
  !insertmacro INTENTIC_UNINSTALL_TRACE "preuninstall: instdir=$INSTDIR exedir=$EXEDIR update=$UpdateMode"
  StrCpy $IntenticReinstall 0
  ${If} ${FileExists} "$EXEDIR\${MAINBINARYNAME}.exe"
    StrCpy $IntenticReinstall 1
    ${If} $DeleteAppDataCheckboxState <> 1
      StrCpy $UpdateMode 1
    ${EndIf}
  ${EndIf}
  !insertmacro INTENTIC_STOP_PROCESSES
  !insertmacro INTENTIC_UNINSTALL_TRACE "process stop complete: update=$UpdateMode reinstall=$IntenticReinstall"
  StrCpy $IntenticAgentKept 0
  ${If} $UpdateMode <> 1
    ${If} ${FileExists} "$PROFILE\.intentic\machine\bin\intentic-machine.exe"
      StrCpy $IntenticAgentKept 1
      ${If} $PassiveMode <> 1
      ${AndIf} $IntenticReinstall <> 1
        ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the Intentic machine agent from this PC?$\r$\n$\r$\nIt keeps your sandboxes connected and starts Docker Desktop when you sign in. Your sandboxes and their files are not deleted either way." /SD IDNO IDYES`
          DetailPrint "Removing the Intentic machine agent..."
          nsExec::ExecToLog /TIMEOUT=120000 '"$PROFILE\.intentic\machine\bin\intentic-machine.exe" uninstall'
          Pop $0
          ${If} $0 == 0
            StrCpy $IntenticAgentKept 0
          ${Else}
            DetailPrint "The machine agent did not uninstall ($0). Run: intentic-machine uninstall"
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
    ; Signed out on this PC: the session cookie, wherever this WebView2 keeps it, and the account's name.
    StrCpy $1 0
    ${Do}
      Delete "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Network\Cookies"
      Delete "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Network\Cookies-journal"
      Delete "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Cookies"
      Delete "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Cookies-journal"
      ${IfNot} ${FileExists} "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Network\Cookies"
      ${AndIfNot} ${FileExists} "$LOCALAPPDATA\${BUNDLEID}\EBWebView\Default\Cookies"
        ${ExitDo}
      ${EndIf}
      IntOp $1 $1 + 1
      ${If} $1 >= 10
        DetailPrint "The webview still holds its cookies; you may still be signed in."
        ${ExitDo}
      ${EndIf}
      Sleep 500
    ${Loop}
    Delete "$APPDATA\${BUNDLEID}\roster.json"
    ; The terminal command's PATH entry the app was to finish (src/cli_path.rs): there is no app left to finish it.
    Delete "$APPDATA\${BUNDLEID}\cli-path-pending"
    ; A setup parked for the next sign-in (resume.rs), and the entry that would start it: left behind, Windows would try
    ; a missing program at every sign-in, and a reinstall would resume a setup the reader walked away from. An update
    ; keeps both, since the entry names the same program and the setup is still the reader's.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "IntenticResumeSetup"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\RunOnce" "IntenticResumeSetup"
    Delete "$APPDATA\${BUNDLEID}\resume-setup.json"
    ; The tray's "Start Intentic at login" (src/autostart.rs), for the same reason: a program that is gone, started at
    ; every sign-in. An update keeps it, since it names the same program.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Intentic"
    ; The Explorer menu's package, while its DLL is still here to remove it (an update keeps it: the install that
    ; follows re-registers only what changed, and asks nothing). Removing it also ends the surrogate holding the DLL.
    !insertmacro INTENTIC_UNINSTALL_TRACE "unregistering Explorer menu"
    !insertmacro INTENTIC_REGSVR32 "/s /u /n /i:quiet"
    !insertmacro INTENTIC_UNINSTALL_TRACE "Explorer menu unregister returned $0"
  ${EndIf}
  !insertmacro RestartManager_StartSession $R0
  !insertmacro INTENTIC_UNINSTALL_TRACE "Restart Manager session=$R0 result=$0"
  ${If} $R0 != ""
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro INTENTIC_UNINSTALL_TRACE "Restart Manager registered app: result=$0"
    System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i .r2, p 0, *i .r3) i .r0'
    !insertmacro INTENTIC_UNINSTALL_TRACE "Restart Manager list: result=$0 needed=$1 count=$2 reboot=$3"
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}
  !insertmacro INTENTIC_UNINSTALL_TRACE "preuninstall complete"
!macroend

; ...AND THE SAME PROBLEM ON THE WAY IN, which arrived with the app updating itself in the background.
;
; A background update runs THIS installer over a copy of the app that is quitting as it starts: the updater
; plugin fires ShellExecute on the installer and then exits the process, so the two overlap by however long it
; takes Windows to tear a WebView2 host down. `installer.nsi`'s own `CheckIfAppIsRunning` meets that overlap
; with a MessageBox — in `passive` mode, which is the mode a background update uses precisely because it asks
; nothing, so the prompt appears with no installer window around it to explain itself. What the user sees is a
; dialog about Intentic still running, seconds after they pressed nothing at all.
;
; Ending it here means that check finds nothing, exactly as the uninstall hook above does. The kill is safe on
; the update path (the process is already on its way out) and correct on the manual one (somebody running the
; downloaded installer over a copy they left open); if it fails, the built-in check still runs and still asks,
; which is the right fallback rather than a silent overwrite.
;
; The file server is ended as well, for the reason the uninstall hook gives: a sidecar slow to exit holds
; intentic-files.exe, and the installer's overwrite of it fails.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro INTENTIC_STOP_PROCESSES
  !insertmacro INTENTIC_EXPLORER_MENU_STEP_ASIDE
!macroend

; THE EXPLORER MENU'S DLL MAY BE IN USE (explorer-menu/README.md). Explorer's COM surrogate (a dllhost.exe) loads
; intentic_explorer_menu.dll whenever a context menu opens and keeps it a while, and a loaded DLL cannot be overwritten:
; the copy below would stop on "Error opening file for writing". It can be renamed, though, so the old copy steps aside
; under a name of its own and goes at the next install or the uninstall, once nothing holds it. Killing the surrogate
; instead would mean telling one dllhost from another, and ending somebody else's.
!macro INTENTIC_EXPLORER_MENU_STEP_ASIDE
  Delete "$INSTDIR\intentic_explorer_menu.dll.*.old"
  ${If} ${FileExists} "$INSTDIR\intentic_explorer_menu.dll"
    System::Call "kernel32::GetTickCount() i .r0"
    Rename "$INSTDIR\intentic_explorer_menu.dll" "$INSTDIR\intentic_explorer_menu.dll.$0.old"
  ${EndIf}
!macroend

; "OPEN WITH INTENTIC" ON A FOLDER, the space inside one and a document: the folder half of what the file associations
; in tauri.conf.json do for documents. The app reads the paths it is handed as any second launch's (src/local.rs
; `open_args`) and shows each in a window of its own; nothing runs in a sandbox until the user asks for one there.
;
; Two ways onto the menu, and why (explorer-menu/README.md has the measurements):
;   - Windows 11's own menu lists only commands declared by a PACKAGE. intentic_explorer_menu.dll is that command, and
;     its DllInstall registers the package that declares it: the release's signed one when this build carried one
;     (intentic-explorer-menu.msix), else one it signs on this PC, which costs one UAC prompt the first time. `quiet`
;     never prompts: an update the app runs in the background, a passive or a silent install keeps whatever
;     registration is there, and an unattended first install goes without until an interactive one.
;   - The classic registry verb, shown under "Show more options" on Windows 11 and as the menu itself on Windows 10.
;     Written whenever the package is not in place (Windows 10, a declined prompt, any failure, which
;     ~/.intentic/logs/explorer-menu.log names), and removed when it is, so the entry is never there twice.
; Per user, under HKCU and in this user's packages, like the install itself (`installMode: currentUser`), and gone
; with the uninstall below: an entry left behind would start an app that is no longer there.
!macro NSIS_HOOK_POSTINSTALL
  StrCpy $1 "interactive"
  ${If} $UpdateMode = 1
  ${OrIf} $PassiveMode = 1
  ${OrIf} ${Silent}
    StrCpy $1 "quiet"
  ${EndIf}
  ; The one step that may stop for an administrator, and Windows' prompt names its own rundll32, not Intentic: said
  ; on the progress line first, so the reader knows what is asking and why the install is waiting on it (2026-10-12:
  ; the prompt came up under "Extract: intentic-desktop.exe" with nothing on the page about it).
  ${If} $1 == "interactive"
    DetailPrint "Adding $\"Open with Intentic$\" to Explorer's menu. Windows may ask once for permission, as $\"Windows host process (Rundll32)$\"."
  ${EndIf}
  !insertmacro INTENTIC_REGSVR32 "/s /n /i:$1"
  ${If} $0 == 0
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Intentic"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Intentic"
  ${Else}
    WriteRegStr HKCU "Software\Classes\Directory\shell\Intentic" "" "Open with Intentic"
    WriteRegStr HKCU "Software\Classes\Directory\shell\Intentic" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
    WriteRegStr HKCU "Software\Classes\Directory\shell\Intentic\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
    WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Intentic" "" "Open with Intentic"
    WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Intentic" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
    WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Intentic\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
  ${EndIf}
  !insertmacro INTENTIC_CLI_PATH add
!macroend

; `intentic .` IN A TERMINAL, the way `code .` opens VS Code (2026-10-11). `$INSTDIR\bin` holds two launchers
; (src-tauri/cli, bundled by tauri.windows.conf.json): intentic.cmd for cmd and PowerShell, and `intentic`, a sh script
; that WSL and Git Bash find on the same PATH and that turns a Linux path into its Windows name before handing it over.
; Both start ${MAINBINARYNAME}.exe beside them with the path, which the app opens like any other it is handed
; (src/local.rs `open_args`). Every install puts the folder on the user's PATH, so an existing install gets the command
; with its next update, and the uninstall takes it off again.
;
; The edit is PowerShell's, not this script's. NSIS strings stop at NSIS_MAX_STRLEN, 1024 characters in the build
; that makes this installer, and a user PATH is often longer: read, appended and written back here, it would come back
; cut short, and every tool past the cut would vanish from the user's shell. PowerShell reads HKCU\Environment without
; expanding it and writes it back under the kind it had, so %USERPROFILE%-style entries keep expanding: the same way
; connect.ps1 puts `ic` on that PATH. Only the entry itself is added or removed, matched as a whole entry; the rest of
; the value is left as it was. The folder goes by an environment variable rather than inside the command, so no
; character in a user's folder name can end a quoted string. A failure leaves the PATH alone and the launchers where
; they are, and is written in the install's details: the command is a convenience, the app is the install. A failed add
; also leaves `cli-path-pending` in the app's config folder, and the app adds the folder at its next launch
; (src/cli_path.rs), so the command does not stay missing behind an install that said it completed.
;
; The broadcast is the one the Control Panel's editor sends: without it, a terminal started from Explorer would not see
; the new PATH until the next sign-in. A terminal open already keeps the PATH it had.
!macro INTENTIC_CLI_PATH VERB
  !if "${VERB}" == "add"
    !define /redef INTENTIC_CLI_PS `$$ErrorActionPreference = 'Stop'; $$d = $$env:INTENTIC_CLI_DIR; $$k = Get-Item -LiteralPath 'HKCU:\Environment'; $$p = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); if (@($$p -split ';') -notcontains $$d) { $$t = if ($$k.GetValueNames() -contains 'Path') { $$k.GetValueKind('Path') } else { 'ExpandString' }; $$v = if ($$p.TrimEnd(';')) { $$p.TrimEnd(';') + ';' + $$d } else { $$d }; Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Type $$t -Value $$v -ErrorAction Stop }`
  !else
    !define /redef INTENTIC_CLI_PS `$$ErrorActionPreference = 'Stop'; $$d = $$env:INTENTIC_CLI_DIR; $$k = Get-Item -LiteralPath 'HKCU:\Environment'; if ($$k.GetValueNames() -contains 'Path') { $$e = @(([string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')) -split ';'); if ($$e -contains $$d) { Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name Path -Type $$k.GetValueKind('Path') -Value (@($$e | Where-Object { $$_ -ne $$d }) -join ';') -ErrorAction Stop } }`
  !endif
  System::Call 'kernel32::SetEnvironmentVariable(t "INTENTIC_CLI_DIR", t "$INSTDIR\bin")'
  nsExec::Exec /TIMEOUT=60000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${INTENTIC_CLI_PS}"`
  Pop $0
  ${If} $0 == 0
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    !if "${VERB}" == "add"
      Delete "$APPDATA\${BUNDLEID}\cli-path-pending"
    !endif
  ${Else}
    !if "${VERB}" == "add"
      ; PowerShell can take longer than the minute just to start on a busy PC (2026-10-12: "(timeout)", and an install
      ; that still said it completed). The marker is the app's to finish at its next launch (src/cli_path.rs).
      Push $3
      CreateDirectory "$APPDATA\${BUNDLEID}"
      FileOpen $3 "$APPDATA\${BUNDLEID}\cli-path-pending" w
      FileClose $3
      Pop $3
      DetailPrint "Could not add $INSTDIR\bin to your PATH yet ($0). Intentic adds it the next time it starts."
    !else
      DetailPrint "Could not ${VERB} $INSTDIR\bin on your PATH ($0). The intentic command is in that folder."
    !endif
  ${EndIf}
!macroend

; regsvr32 on the menu's DLL, its exit code in $0 (0 is success). The 64-bit regsvr32 for a 64-bit DLL: this installer
; may be a 32-bit process, whose System32 is SysWOW64, and Sysnative is how such a process names the real one (a 64-bit
; process has no Sysnative, and its $SYSDIR is already right).
!macro INTENTIC_REGSVR32 FLAGS
  StrCpy $2 "$SYSDIR\regsvr32.exe"
  ${If} ${FileExists} "$WINDIR\Sysnative\regsvr32.exe"
    StrCpy $2 "$WINDIR\Sysnative\regsvr32.exe"
  ${EndIf}
  StrCpy $0 1
  ${If} ${FileExists} "$INSTDIR\intentic_explorer_menu.dll"
    nsExec::Exec '"$2" ${FLAGS} "$INSTDIR\intentic_explorer_menu.dll"'
    Pop $0
  ${EndIf}
!macroend

; WHAT STAYS, said on the way out (2026-10-05): an uninstall that ends in silence lets the reader believe their
; sandboxes went with the app, when every container is still in Docker and keeps its data. Only where `ic` is installed,
; which is every PC a sandbox was set up on; never on an update, a passive or a silent uninstall.
!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro INTENTIC_UNINSTALL_TRACE "postuninstall entered"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Intentic"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Intentic"
  ; The terminal command's folder is gone (INTENTIC_CLI_PATH), so is its PATH entry. On an update too: the install that
  ; follows puts it back, under whatever folder it installs to.
  !insertmacro INTENTIC_CLI_PATH remove
  !insertmacro INTENTIC_UNINSTALL_TRACE "PATH removal returned $0"
  ; Copies of the menu's DLL an earlier update stepped aside from (INTENTIC_EXPLORER_MENU_STEP_ASIDE).
  Delete "$INSTDIR\intentic_explorer_menu.dll.*.old"
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIf} $IntenticReinstall <> 1
  ${AndIf} ${FileExists} "$PROFILE\.intentic\ic\bin\ic.exe"
    ${If} $IntenticAgentKept = 1
      MessageBox MB_OK|MB_ICONINFORMATION "Intentic is removed, and you are signed out on this PC.$\r$\n$\r$\nYour sandboxes and their files stay on this PC, in Docker. In a terminal, ic sandbox list shows them and ic sandbox remove <name> removes one (it stays recoverable for a week).$\r$\n$\r$\nThe machine agent stays too. intentic-machine uninstall removes it." /SD IDOK
    ${Else}
      MessageBox MB_OK|MB_ICONINFORMATION "Intentic is removed, and you are signed out on this PC.$\r$\n$\r$\nYour sandboxes and their files stay on this PC, in Docker. In a terminal, ic sandbox list shows them and ic sandbox remove <name> removes one (it stays recoverable for a week)." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
