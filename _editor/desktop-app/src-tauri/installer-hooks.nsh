; WHY AN UNINSTALL HOOK AT ALL — this app is meant to be running when you uninstall it.
;
; The tray is where Intentic lives once its window is closed (windows.rs, `hide_to_tray`), so the ordinary
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
