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
!macro NSIS_HOOK_PREUNINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  ; The same settle the built-in check gives itself between killing and looking again.
  Sleep 500
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
!macro NSIS_HOOK_PREINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  Sleep 500
!macroend
