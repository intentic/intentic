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

; The uninstaller's first page is an nsDialogs page (ONE CHOICE, BEFORE ANYTHING GOES, below). MUI2 includes nsDialogs
; already; said here as well, so this file does not lean on what the template happens to include first.
!include nsDialogs.nsh

; Every Var below is declared here, at the top level, because Tauri includes this file there and a Var cannot be
; declared inside a section. The template's own ($PassiveMode, $UpdateMode, $DeleteAppDataCheckboxState) are declared
; AFTER this file is included: the hook macros, inserted later, may use them, and the Functions in this file may not.
;
; Whether the machine agent is still on this PC once the uninstall hook has asked about it (1) or not (0). Asked only
; where the app's own ic is missing (WHAT AN UNINSTALL LEAVES, below): everywhere else ic decides with the page's answer.
Var IntenticAgentKept
; Whether this uninstall is the first half of a reinstall (1): see AN UNINSTALL AN INSTALL IS ABOUT TO UNDO, below.
Var IntenticReinstall
; The answer on the uninstaller's first page, in ic uninstall's own words: "everything" or "keep-sandboxes". Empty when
; the page was never shown (passive, silent, an update, a reinstall, ic running this uninstaller), which the hook reads as
; keep-sandboxes: a sandbox is never deleted by an uninstall nobody was watching.
Var IntenticChoice
; How the page's look at this PC went: "found" once `ic uninstall --dry-run` answered and its file was read; otherwise
; why not ("missing" when there is no ic beside the app, nsExec's "timeout" or "error", ic's exit code, "unreadable").
Var IntenticLook
; What it found, from the [inventory] section of its file (the contract in _sandbox/ic, `plan::ini`).
Var IntenticSandboxes
Var IntenticDeleteCount
Var IntenticPasswords
Var IntenticEngine
Var IntenticDataSize
Var IntenticSandboxList
Var IntenticFound
Var IntenticStays
; The page's two options, and the bold font their names are drawn in (made once: the page is drawn again on Back).
Var IntenticRadioAll
Var IntenticRadioKeep
Var IntenticBoldFont
; What `ic uninstall` answered in the hook: nsExec's exit code ("0" is done), "timeout" or "error". "by-ic" when ic is
; what started this uninstaller; empty when there was no ic to run.
Var IntenticIcResult
; Whether some of the app's own folders could not be deleted (1): the last page then does not say nothing is left.
Var IntenticAppFilesLeft

; The app's binary by name, for the page's reinstall check. A Function in this file is read where Tauri includes it,
; before the template defines ${MAINBINARYNAME}, so it cannot use that name; NSIS_HOOK_PREUNINSTALL, inserted later,
; refuses to build when the two disagree, so a renamed binary cannot quietly turn every uninstall into a "reinstall".
!define INTENTIC_APP_EXE "intentic-desktop.exe"

; ONE CHOICE, BEFORE ANYTHING GOES (2026-10-18). Uninstalling the app was the one way most people would ever try to
; remove Intentic, and it removed the app alone: the sandboxes, their data, the engine with its tens of gigabytes, the
; machine agent, ic and the saved passwords stayed on the PC with nothing on screen saying how to take them away. What
; else is here is ic's to know and to remove (`ic uninstall`, the one orchestrator every way of uninstalling goes
; through), so this page asks it first (`--dry-run --ini`) and offers what it found as one choice:
;   - "Remove everything", preselected, because removing Intentic is what someone uninstalling it asked for;
;   - "Keep my sandboxes", for someone who runs them without the app: they keep running, with what keeps them up.
; Preselecting the outcome that deletes is safe only because Next is not the deletion: with sandboxes on the PC a second
; question names them and defaults to No, which comes back here. With nothing of the reader's own to lose (no sandbox, no
; saved password) there is nothing to choose, and the page only says what goes.
;
; The page comes first, ahead of Tauri's confirm page (`UninstPage` here precedes the template's MUI_UNPAGE_CONFIRM),
; and the hook acts on its answer: nothing is touched before the reader has pressed Uninstall there.
;
; Never shown, so never answered, where nobody watches or nothing but the app goes: passive (/P) and silent (/S) runs,
; an update (/UPDATE) and a reinstall's uninstall (AN UNINSTALL AN INSTALL IS ABOUT TO UNDO, below), and ic itself
; running this uninstaller (INTENTIC_UNINSTALL=done) after doing the rest. An unanswered page keeps the sandboxes.
;
; ic gets a minute to look (docker, WSL), behind a banner, since the window has nothing to show until it answers. When
; it is missing, fails or says nothing readable, the page says only the app goes and the hook keeps the sandboxes: a
; choice built on a guess about what is on the PC is not one to offer.
UninstPage custom un.IntenticChoiceShow un.IntenticChoiceLeave

Function un.IntenticChoiceShow
  ; $PassiveMode and $UpdateMode do not exist yet where this Function is read, so the switches are read again from the
  ; command line, the way the template's un.onInit reads them.
  ClearErrors
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    Abort
  ${EndIf}
  ${If} ${Silent}
  ${OrIf} ${FileExists} "$EXEDIR\${INTENTIC_APP_EXE}"
    Abort
  ${EndIf}
  ReadEnvStr $0 INTENTIC_UNINSTALL
  ${If} $0 == "done"
    Abort
  ${EndIf}

  ; Once: Back from the confirm page draws this page again, from what was found the first time.
  ${If} $IntenticLook == ""
    Call un.IntenticLook
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}
  ${If} $IntenticBoldFont == ""
    CreateFont $IntenticBoldFont "$(^Font)" "$(^FontSize)" "700"
  ${EndIf}
  StrCpy $IntenticRadioAll ""
  StrCpy $IntenticRadioKeep ""

  ${If} $IntenticLook != "found"
    StrCpy $IntenticChoice "keep-sandboxes"
    !insertmacro MUI_HEADER_TEXT "Uninstall Intentic" "The Intentic app is removed."
    ${NSD_CreateLabel} 0 0 100% 60u "Intentic could not check what else it has on this PC, so only the app goes, and folder sync to this PC stops. Nothing else is touched: your sandboxes, if this PC has any, stay and keep running.$\r$\n$\r$\nTo remove the rest later, run ic uninstall in a terminal."
    Pop $0
  ${ElseIf} $IntenticSandboxes > 0
  ${OrIf} $IntenticDeleteCount > 0
  ${OrIf} $IntenticPasswords == 1
    ; Named for what there is: the sandboxes when there are any, else the passwords (ic's own pick says the same).
    ${If} $IntenticSandboxes > 0
    ${OrIf} $IntenticDeleteCount > 0
      !insertmacro MUI_HEADER_TEXT "Uninstall Intentic" "Choose what happens to your sandboxes."
      StrCpy $2 "Keep my sandboxes"
      ${If} $IntenticEngine == 1
        StrCpy $4 "They keep running on this PC, with the engine and the machine agent that keep them up. Only the app, folder sync and caches go."
      ${Else}
        StrCpy $4 "They keep running on this PC, with the machine agent that keeps them up. Only the app, folder sync and caches go."
      ${EndIf}
    ${Else}
      !insertmacro MUI_HEADER_TEXT "Uninstall Intentic" "Choose what happens to your saved passwords."
      StrCpy $2 "Keep my passwords"
      StrCpy $4 "They stay on this PC, with the machine agent that keeps them. Only the app, folder sync and caches go."
    ${EndIf}
    ; "your 3 sandboxes (22 GB) and your saved passwords"
    StrCpy $3 ""
    ${If} $IntenticSandboxes = 1
      StrCpy $3 "your sandbox"
    ${ElseIf} $IntenticSandboxes > 1
      StrCpy $3 "your $IntenticSandboxes sandboxes"
    ${EndIf}
    ${If} $3 != ""
    ${AndIf} $IntenticDataSize != ""
      StrCpy $3 "$3 ($IntenticDataSize)"
    ${EndIf}
    ${If} $IntenticPasswords == 1
      ${If} $3 != ""
        StrCpy $3 "$3 and "
      ${EndIf}
      StrCpy $3 "$3your saved passwords"
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 34u "Intentic has this on your PC:$\r$\n$IntenticFound"
    Pop $0
    ${NSD_CreateRadioButton} 0 37u 100% 10u "Remove everything"
    Pop $IntenticRadioAll
    SendMessage $IntenticRadioAll ${WM_SETFONT} $IntenticBoldFont 1
    ${NSD_CreateLabel} 12u 48u -12u 26u "Deletes $3, then the rest of Intentic: nothing of it stays on this PC. This can't be undone."
    Pop $0
    ${NSD_OnClick} $0 un.IntenticPickEverything
    ${NSD_CreateRadioButton} 0 75u 100% 10u $2
    Pop $IntenticRadioKeep
    SendMessage $IntenticRadioKeep ${WM_SETFONT} $IntenticBoldFont 1
    ${NSD_CreateLabel} 12u 86u -12u 26u $4
    Pop $0
    ${NSD_OnClick} $0 un.IntenticPickKeep
    ${If} $IntenticStays != ""
      ${NSD_CreateLabel} 0 115u 100% 24u $IntenticStays
      Pop $0
    ${EndIf}
    ; The first visit preselects everything; a visit back from the confirm page shows what was picked.
    ${If} $IntenticChoice == "keep-sandboxes"
      ${NSD_Check} $IntenticRadioKeep
      ${NSD_SetFocus} $IntenticRadioKeep
    ${Else}
      ${NSD_Check} $IntenticRadioAll
      ${NSD_SetFocus} $IntenticRadioAll
    ${EndIf}
  ${Else}
    StrCpy $IntenticChoice "everything"
    !insertmacro MUI_HEADER_TEXT "Uninstall Intentic" "Everything Intentic put on this PC is removed."
    ${NSD_CreateLabel} 0 0 100% 34u "Intentic has this on your PC:$\r$\n$IntenticFound"
    Pop $0
    ${NSD_CreateLabel} 0 40u 100% 20u "Uninstalling removes all of it: nothing of Intentic stays on this PC."
    Pop $0
    ${If} $IntenticStays != ""
      ${NSD_CreateLabel} 0 64u 100% 24u $IntenticStays
      Pop $0
    ${EndIf}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

; A click on an option's description picks it, as a click on its name does.
Function un.IntenticPickEverything
  Pop $0
  ${NSD_Uncheck} $IntenticRadioKeep
  ${NSD_Check} $IntenticRadioAll
FunctionEnd

Function un.IntenticPickKeep
  Pop $0
  ${NSD_Uncheck} $IntenticRadioAll
  ${NSD_Check} $IntenticRadioKeep
FunctionEnd

Function un.IntenticChoiceLeave
  ${If} $IntenticRadioAll != ""
    ${NSD_GetState} $IntenticRadioAll $0
    ${If} $0 = ${BST_CHECKED}
      StrCpy $IntenticChoice "everything"
    ${Else}
      StrCpy $IntenticChoice "keep-sandboxes"
    ${EndIf}
  ${EndIf}
  ; The second question, for the one answer that deletes sandboxes: Enter on a preselected option is not a decision to
  ; delete somebody's work. No is its default, and it comes back to this page.
  ${If} $IntenticChoice == "everything"
  ${AndIf} $IntenticDeleteCount > 0
    ${If} $IntenticDeleteCount = 1
      StrCpy $0 "Delete your sandbox and its files for good?"
    ${Else}
      StrCpy $0 "Delete $IntenticDeleteCount sandboxes and their files for good?"
    ${EndIf}
    ${If} $IntenticSandboxList != ""
      StrCpy $0 "$0$\r$\n$\r$\n$IntenticSandboxList"
    ${EndIf}
    StrCpy $0 "$0$\r$\n$\r$\nTheir files and their agents' history are deleted with Intentic, and nothing can bring them back. Choose No to go back and keep them."
    ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "$0" /SD IDNO IDNO`
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; What ic finds on this PC, into the page's Vars. Its file goes in the plugins folder, which the uninstaller deletes on
; its way out. nsExec's timeout counts from the last line the program printed: a minute of silence ends the look.
Function un.IntenticLook
  StrCpy $IntenticLook "missing"
  StrCpy $IntenticSandboxes 0
  StrCpy $IntenticDeleteCount 0
  StrCpy $IntenticPasswords 0
  ${IfNot} ${FileExists} "$INSTDIR\intentic-ic.exe"
    Return
  ${EndIf}
  InitPluginsDir
  Delete "$PLUGINSDIR\intentic-inventory.ini"
  Banner::show /set 76 "Checking what Intentic has here..." "Uninstall Intentic"
  nsExec::Exec /TIMEOUT=60000 '"$INSTDIR\intentic-ic.exe" uninstall --dry-run --ini "$PLUGINSDIR\intentic-inventory.ini"'
  Pop $IntenticLook
  Banner::destroy
  ${If} $IntenticLook != "0"
    Return
  ${EndIf}
  ClearErrors
  ReadINIStr $IntenticSandboxes "$PLUGINSDIR\intentic-inventory.ini" "inventory" "sandboxes"
  ReadINIStr $IntenticDeleteCount "$PLUGINSDIR\intentic-inventory.ini" "inventory" "deleteCount"
  ReadINIStr $IntenticPasswords "$PLUGINSDIR\intentic-inventory.ini" "inventory" "passwords"
  ReadINIStr $IntenticFound "$PLUGINSDIR\intentic-inventory.ini" "inventory" "found"
  ${If} ${Errors}
    StrCpy $IntenticLook "unreadable"
    StrCpy $IntenticSandboxes 0
    StrCpy $IntenticDeleteCount 0
    StrCpy $IntenticPasswords 0
    Return
  ${EndIf}
  ; The rest may be absent or empty; a missing one reads as empty.
  ReadINIStr $IntenticEngine "$PLUGINSDIR\intentic-inventory.ini" "inventory" "engine"
  ReadINIStr $IntenticDataSize "$PLUGINSDIR\intentic-inventory.ini" "inventory" "dataSize"
  ReadINIStr $IntenticSandboxList "$PLUGINSDIR\intentic-inventory.ini" "inventory" "sandboxList"
  ReadINIStr $IntenticStays "$PLUGINSDIR\intentic-inventory.ini" "inventory" "stays"
  StrCpy $IntenticLook "found"
FunctionEnd

; TerminateProcess starts shutdown without waiting for it. The process can disappear from a name lookup while
; Restart Manager still reports its executable in use; Tauri's next check then tries to shut that stale owner down,
; silently aborting the uninstall before registry and PATH cleanup. Wait on the same file ownership Tauri checks,
; including the sidecar whose file must be removable too. A bounded wait leaves Tauri's normal failure handling intact.
!macro INTENTIC_STOP_PROCESSES
  Push $0
  Push $1
  Push $2
  Push $3
  Push $R0
  Push $R1
  nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $0
  nsis_tauri_utils::KillProcessCurrentUser "intentic-files.exe"
  Pop $0
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 != ""
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\intentic-files.exe"
    StrCpy $3 0
    ${Do}
      ; A zero-sized list asks only whether any owner remains: ERROR_MORE_DATA means there is one.
      System::Call 'RSTRTMGR::RmGetList(p R0, *i .r1, *i .r2, p 0, *i .R1) i .r0'
      ${If} $0 <> ${ERROR_MORE_DATA}
        ${ExitDo}
      ${EndIf}
      IntOp $3 $3 + 1
      ${If} $3 >= 60
        DetailPrint "Intentic is still closing; checking whether Windows can finish closing it."
        ${ExitDo}
      ${EndIf}
      Sleep 250
    ${Loop}
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}
  Pop $R1
  Pop $R0
  Pop $3
  Pop $2
  Pop $1
  Pop $0
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
; WHAT AN UNINSTALL LEAVES (2026-10-18). The app is one part of what a setup put on this PC. Until 2026-10-05 the
; uninstaller removed that part alone and said nothing; from then until 2026-10-18 it asked about the machine agent
; alone, stopped folder sync, signed out, and said on its last page that the sandboxes, their data, ic and the engine
; stayed, which left a reader who wanted Intentic gone with a list of commands to find. Now ic does the rest, once:
;   - The page's answer (ONE CHOICE, BEFORE ANYTHING GOES, above) goes to `intentic-ic.exe uninstall --without-app
;     --yes`, the copy of ic the app ships beside itself, so it is here even where ic was never set up. "Remove
;     everything" adds `--delete-data --confirm <n>`, n being the count of sandboxes the page named (ic refuses a count
;     that no longer matches, and deletes nothing); with nothing of the reader's own on the PC, `--yes` alone already
;     removes everything. "Keep my sandboxes", and every uninstall that showed no page (passive, silent), is
;     `--keep-sandboxes`: the sandboxes, the engine, ic, the machine agent and the saved passwords stay, folder sync to
;     this PC ends (`intentic-machine sync uninstall --folders`: a PC whose owner uninstalled the app went on syncing a
;     sandbox's /work into her profile until her disk filled) and the caches go. `--without-app` because the app is
;     this uninstaller's to remove.
;   - Not when ic started this uninstaller (INTENTIC_UNINSTALL=done, `ic uninstall` removing the app last): it has done
;     the rest already, and calling it back would run the uninstall twice.
;   - ic gets fifteen minutes of silence before it is ended (nsExec's timeout counts from its last line, and ic prints
;     one per step): deleting sandboxes and unregistering the engine's WSL distro is slow. Keeping the sandboxes gets
;     five. When ic fails, the app still goes: the details say what to run (`ic uninstall`), folder sync is stopped
;     through the agent directly if ic left it running, and the last page says the rest did not go.
;   - The app's own folders go on every real uninstall, "Delete app data" ticked or not: its settings in
;     `%APPDATA%\<identifier>` and the webview's profile in `%LOCALAPPDATA%\<identifier>`, the signed-in session's
;     cookie among it, with the install location Tauri keeps in the registry. They were left unless the box was ticked,
;     so the PC stayed signed in, and "Remove everything" would have left the app's folders behind. Tried for a while:
;     the webview's own processes outlive the app by a moment and hold their files until they exit. Never
;     `%LOCALAPPDATA%\Intentic` as a whole: it is the install folder, and the intentic engine's disk lives in its
;     `engine` folder, which is ic's to remove, and only when asked.
;   - The cookie files, roster.json and the setup parked for the next sign-in still go first, one at a time, as they
;     did before the folders did: they are what must not survive a folder that could not be deleted whole.
;   - Without ic beside the app (a copy that lost intentic-ic.exe, to an antivirus say), the uninstaller does what it
;     did before ic could be asked: it asks "Also remove the Intentic machine agent from this PC?" (`intentic-machine
;     uninstall` removes this PC's links, sync pairings and login entry, never a container), stops folder sync where the
;     agent stays, and says on its last page that the sandboxes stay and how to remove them.
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
; binary is the first half of a reinstall, and it is treated as the update it is: no choice is offered, ic is not called,
; nobody is signed out, and Tauri's own section keeps the shortcuts and the start-at-login value. The one exception is
; a reader who ticked "Delete app data" on the uninstaller's page: they asked for a clean slate, and get Tauri's full
; removal of the app's own files, but still not ic's uninstall, which is no part of the app's data.
!macro NSIS_HOOK_PREUNINSTALL
  !if "${MAINBINARYNAME}.exe" != "${INTENTIC_APP_EXE}"
    !error "installer-hooks.nsh: INTENTIC_APP_EXE is ${INTENTIC_APP_EXE}, but the app's binary is ${MAINBINARYNAME}.exe"
  !endif
  StrCpy $IntenticReinstall 0
  ${If} ${FileExists} "$EXEDIR\${MAINBINARYNAME}.exe"
    StrCpy $IntenticReinstall 1
    ${If} $DeleteAppDataCheckboxState <> 1
      StrCpy $UpdateMode 1
    ${EndIf}
  ${EndIf}
  !insertmacro INTENTIC_STOP_PROCESSES
  StrCpy $IntenticAgentKept 0
  StrCpy $IntenticIcResult ""
  ${If} $UpdateMode <> 1
    ${If} $IntenticReinstall <> 1
      !insertmacro INTENTIC_UNINSTALL_THE_REST
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
    !insertmacro INTENTIC_REGSVR32 "/s /u /n /i:quiet"
  ${EndIf}
!macroend

; Everything of Intentic that is not the app, by ic, as the page was answered (WHAT AN UNINSTALL LEAVES, above). A real
; uninstall only: the hook does not insert it for an update or a reinstall.
;
; nsExec answers "timeout" or "error" where it has no exit code, and an integer comparison reads either as 0, a
; success: every answer here is compared as the string "0".
!macro INTENTIC_UNINSTALL_THE_REST
  ReadEnvStr $0 INTENTIC_UNINSTALL
  ${If} $0 == "done"
    StrCpy $IntenticIcResult "by-ic"
  ${ElseIf} ${FileExists} "$INSTDIR\intentic-ic.exe"
    ${If} $IntenticLook != ""
    ${AndIf} $IntenticLook != "found"
      DetailPrint "Intentic could not check what else it has on this PC ($IntenticLook), so your sandboxes stay."
    ${EndIf}
    StrCpy $1 "--keep-sandboxes"
    StrCpy $2 300000
    ${If} $IntenticChoice == "everything"
      StrCpy $1 ""
      StrCpy $2 900000
      ${If} $IntenticDeleteCount > 0
        StrCpy $1 "--delete-data --confirm $IntenticDeleteCount"
      ${ElseIf} $IntenticSandboxes > 0
      ${OrIf} $IntenticPasswords == 1
        StrCpy $1 "--delete-data"
      ${EndIf}
      DetailPrint "Removing the rest of Intentic. This can take several minutes..."
    ${Else}
      DetailPrint "Stopping folder sync to this PC and deleting Intentic's caches; your sandboxes stay..."
    ${EndIf}
    nsExec::ExecToLog /TIMEOUT=$2 '"$INSTDIR\intentic-ic.exe" uninstall --without-app --yes $1'
    Pop $IntenticIcResult
    ${If} $IntenticIcResult != "0"
      DetailPrint "The rest of Intentic was not removed ($IntenticIcResult); the app is removed all the same. To finish, run in a terminal: ic uninstall"
      ; Folder sync is the one thing that must not outlive the app (WHAT AN UNINSTALL LEAVES): ended through the agent
      ; directly where ic did not get that far. Every outcome ends it, so this is never more than was asked.
      ${If} ${FileExists} "$PROFILE\.intentic\machine\bin\intentic-machine.exe"
        !insertmacro INTENTIC_STOP_FOLDER_SYNC
      ${EndIf}
    ${EndIf}
  ${Else}
    ; No ic beside the app: the agent alone, as before ic could be asked.
    ${If} ${FileExists} "$PROFILE\.intentic\machine\bin\intentic-machine.exe"
      StrCpy $IntenticAgentKept 1
      ${If} $PassiveMode <> 1
        ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION "Also remove the Intentic machine agent from this PC?$\r$\n$\r$\nIt keeps your sandboxes connected and starts Docker Desktop when you sign in. Folder sync to this PC stops either way; your sandboxes and the synced folders' files are not deleted." /SD IDNO IDYES`
          DetailPrint "Removing the Intentic machine agent..."
          nsExec::ExecToLog /TIMEOUT=120000 '"$PROFILE\.intentic\machine\bin\intentic-machine.exe" uninstall'
          Pop $0
          ${If} $0 == "0"
            StrCpy $IntenticAgentKept 0
          ${Else}
            DetailPrint "The machine agent did not uninstall ($0). Run: intentic-machine uninstall"
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ; A Yes that went through has ended folder sync already.
      ${If} $IntenticAgentKept = 1
        !insertmacro INTENTIC_STOP_FOLDER_SYNC
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Folder sync to this PC ends through the machine agent: every pairing that syncs a folder here is unpaired and its
; Mutagen sessions end; port mirroring, which keeps sandboxes connected, stays. The synced folders keep their files.
!macro INTENTIC_STOP_FOLDER_SYNC
  DetailPrint "Stopping folder sync to this PC..."
  nsExec::ExecToLog /TIMEOUT=120000 '"$PROFILE\.intentic\machine\bin\intentic-machine.exe" sync uninstall --folders'
  Pop $0
  ; An agent older than `--folders` refuses the flag: the whole `sync uninstall` then, since a folder still syncing
  ; after the app is gone is what this step exists to prevent.
  ${If} $0 != "0"
    nsExec::ExecToLog /TIMEOUT=120000 '"$PROFILE\.intentic\machine\bin\intentic-machine.exe" sync uninstall'
    Pop $0
  ${EndIf}
  ${If} $0 != "0"
    DetailPrint "Folder sync did not stop ($0). Run: intentic-machine sync uninstall --folders"
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

; The app's own folders, on every real uninstall (WHAT AN UNINSTALL LEAVES, above), and Tauri's record of where it was
; installed: what "Delete app data" removes, which a reader no longer has to know to tick. Tried for ten seconds, since a
; webview process that outlived the app holds its profile until it exits, and once it has exited nothing writes there
; again. Never the install folder as a whole (`$LOCALAPPDATA\Intentic`): the intentic engine's disk is in it.
!macro INTENTIC_REMOVE_APP_DATA
  SetShellVarContext current
  DeleteRegKey HKCU "${MANUPRODUCTKEY}"
  DeleteRegKey /ifempty HKCU "${MANUKEY}"
  StrCpy $IntenticAppFilesLeft 0
  StrCpy $1 0
  ${Do}
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
    RMDir /r "$APPDATA\${BUNDLEID}"
    ${IfNot} ${FileExists} "$LOCALAPPDATA\${BUNDLEID}\*.*"
    ${AndIfNot} ${FileExists} "$APPDATA\${BUNDLEID}\*.*"
      ${ExitDo}
    ${EndIf}
    IntOp $1 $1 + 1
    ${If} $1 >= 20
      StrCpy $IntenticAppFilesLeft 1
      DetailPrint "Some of the app's own files are still in use and were left in $LOCALAPPDATA\${BUNDLEID} and $APPDATA\${BUNDLEID}."
      ${ExitDo}
    ${EndIf}
    Sleep 500
  ${Loop}
!macroend

; WHAT STAYS, said on the way out (2026-10-05, and 2026-10-18 for ic's half): an uninstall that ends in silence lets the
; reader believe whatever they assumed went, gone or kept. Said once the app's files are gone, after an interactive
; real uninstall only: never on an update, a reinstall, a passive or a silent run (/SD), nor when ic started this
; uninstaller, since ic says what it did itself.
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Intentic"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Intentic"
  ; The terminal command's folder is gone (INTENTIC_CLI_PATH), so is its PATH entry. On an update too: the install that
  ; follows puts it back, under whatever folder it installs to.
  !insertmacro INTENTIC_CLI_PATH remove
  ; Copies of the menu's DLL an earlier update stepped aside from (INTENTIC_EXPLORER_MENU_STEP_ASIDE).
  Delete "$INSTDIR\intentic_explorer_menu.dll.*.old"
  ${If} $UpdateMode <> 1
  ${AndIf} $IntenticReinstall <> 1
    !insertmacro INTENTIC_REMOVE_APP_DATA
    ${If} $PassiveMode <> 1
      !insertmacro INTENTIC_SAY_WHAT_STAYS
    ${EndIf}
  ${EndIf}
!macroend

!macro INTENTIC_SAY_WHAT_STAYS
  ${If} $IntenticIcResult == "by-ic"
    ; ic started this uninstaller and reports for both.
  ${ElseIf} $IntenticIcResult == ""
    ; No ic beside the app (the agent-only path): the sandboxes stay, said where ic is installed to remove them.
    ${If} ${FileExists} "$PROFILE\.intentic\ic\bin\ic.exe"
      ${If} $IntenticAgentKept = 1
        MessageBox MB_OK|MB_ICONINFORMATION "Intentic is removed, and you are signed out on this PC.$\r$\n$\r$\nYour sandboxes and their files stay on this PC. In a terminal, ic uninstall removes them and the rest of Intentic.$\r$\n$\r$\nFolder sync to this PC has stopped; the synced folders keep their files. The machine agent stays, to keep your sandboxes connected." /SD IDOK
      ${Else}
        MessageBox MB_OK|MB_ICONINFORMATION "Intentic is removed, and you are signed out on this PC.$\r$\n$\r$\nYour sandboxes and their files stay on this PC. In a terminal, ic uninstall removes them and the rest of Intentic." /SD IDOK
      ${EndIf}
    ${EndIf}
  ${ElseIf} $IntenticIcResult != "0"
    ${If} $IntenticChoice == "everything"
      StrCpy $0 "The Intentic app is uninstalled, but the rest of Intentic could not be removed (ic uninstall answered $IntenticIcResult)."
    ${Else}
      StrCpy $0 "The Intentic app is uninstalled and your sandboxes stay, but stopping folder sync and deleting the caches did not finish (ic uninstall answered $IntenticIcResult)."
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$0$\r$\n$\r$\nTo finish, run ic uninstall in a terminal: it shows what is left and removes it. Show details, in this window, lists what went wrong." /SD IDOK
  ${ElseIf} $IntenticChoice == "everything"
    StrCpy $0 "Intentic is uninstalled. Nothing of it is left on this PC."
    ${If} $IntenticAppFilesLeft = 1
      StrCpy $0 "Intentic is uninstalled, but a program still held some of the app's own files: they stay in $LOCALAPPDATA\${BUNDLEID} and $APPDATA\${BUNDLEID}, and can be deleted once Windows has restarted."
    ${EndIf}
    ${If} $IntenticStays != ""
      StrCpy $0 "$0$\r$\n$\r$\n$IntenticStays None of that is Intentic's to remove."
    ${EndIf}
    MessageBox MB_OK|MB_ICONINFORMATION "$0" /SD IDOK
  ${Else}
    StrCpy $1 "the machine agent and ic"
    ${If} $IntenticEngine == 1
      StrCpy $1 "the intentic engine, the machine agent and ic"
    ${EndIf}
    ${If} $IntenticLook != "found"
      StrCpy $0 "The Intentic app is uninstalled. The rest of Intentic stays as it was: your sandboxes, if this PC has any, keep running."
    ${ElseIf} $IntenticSandboxes = 1
      StrCpy $0 "The Intentic app is uninstalled. Your sandbox keeps running on this PC, with what keeps it up: $1."
    ${ElseIf} $IntenticSandboxes > 1
      StrCpy $0 "The Intentic app is uninstalled. Your $IntenticSandboxes sandboxes keep running on this PC, with what keeps them up: $1."
    ${Else}
      StrCpy $0 "The Intentic app is uninstalled. Your saved passwords stay on this PC, with the machine agent and ic."
    ${EndIf}
    MessageBox MB_OK|MB_ICONINFORMATION "$0$\r$\n$\r$\nFolder sync to this PC has stopped; the synced folders keep their files. To remove the rest later, run ic uninstall in a terminal." /SD IDOK
  ${EndIf}
!macroend
