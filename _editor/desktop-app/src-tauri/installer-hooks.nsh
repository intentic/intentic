; WHOSE INSTALLER THIS IS, SAID ON THE INSTALLER — the one line of branding that is reachable from here.
;
; MUI stamps a footer across the bottom of every page of the wizard and, left alone, fills it with its own
; name and build: a first-run install of this product spent five screens captioned
; "Nullsoft Install System v3.08-3+deb12u1". Two things are wrong with that and only one of them is vanity.
; The user is being asked to run an UNSIGNED binary they downloaded — the one moment in onboarding where they
; are actively looking for a reason to trust or distrust what is on screen — and the only proper noun on the
; window is a build toolchain they have never heard of, wearing a Debian package version, because this
; installer is cross-built on a Linux runner. It reads as somebody else's software.
;
; Tauri includes this file at the top of its template (ahead of everything MUI draws) and defines
; MUI_BRANDINGTEXT nowhere itself, so defining it here is simply the supported way to set it: MUI's own
; default is `!ifndef`-guarded and yields to whatever is already defined. It is a literal rather than
; "Intentic ${VERSION}" on purpose — PRODUCTNAME and VERSION are defined further DOWN the template than this
; include, so referencing them here would name nothing.
!define MUI_BRANDINGTEXT "Intentic"

; Whether the machine agent is still on this PC once the uninstall hook has asked about it (1) or not (0): the last
; page says what stays, and the agent is part of that only when it stayed. Declared here, at the top level, because
; Tauri includes this file there and a Var cannot be declared inside a section.
Var IntenticAgentKept

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
!macro NSIS_HOOK_PREUNINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  nsis_tauri_utils::KillProcessCurrentUser "intentic-files.exe"
  Pop $0
  ; The same settle the built-in check gives itself between killing and looking again.
  Sleep 500
  StrCpy $IntenticAgentKept 0
  ${If} $UpdateMode <> 1
    ${If} ${FileExists} "$PROFILE\.intentic\machine\bin\intentic-machine.exe"
      StrCpy $IntenticAgentKept 1
      ${If} $PassiveMode <> 1
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
    ; The Explorer menu's package, while its DLL is still here to remove it (an update keeps it: the install that
    ; follows re-registers only what changed, and asks nothing). Removing it also ends the surrogate holding the DLL.
    !insertmacro INTENTIC_REGSVR32 "/s /u /n /i:quiet"
  ${EndIf}
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
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  nsis_tauri_utils::KillProcessCurrentUser "intentic-files.exe"
  Pop $0
  Sleep 500
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
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Intentic"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Intentic"
  ; Copies of the menu's DLL an earlier update stepped aside from (INTENTIC_EXPLORER_MENU_STEP_ASIDE).
  Delete "$INSTDIR\intentic_explorer_menu.dll.*.old"
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIf} ${FileExists} "$PROFILE\.intentic\ic\bin\ic.exe"
    ${If} $IntenticAgentKept = 1
      MessageBox MB_OK|MB_ICONINFORMATION "Intentic is removed, and you are signed out on this PC.$\r$\n$\r$\nYour sandboxes and their files stay on this PC, in Docker. In a terminal, ic sandbox list shows them and ic sandbox remove <name> removes one (it stays recoverable for a week).$\r$\n$\r$\nThe machine agent stays too. intentic-machine uninstall removes it." /SD IDOK
    ${Else}
      MessageBox MB_OK|MB_ICONINFORMATION "Intentic is removed, and you are signed out on this PC.$\r$\n$\r$\nYour sandboxes and their files stay on this PC, in Docker. In a terminal, ic sandbox list shows them and ic sandbox remove <name> removes one (it stays recoverable for a week)." /SD IDOK
    ${EndIf}
  ${EndIf}
!macroend
