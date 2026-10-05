---
name: android
description: Work on "${id}", the user's OWN Android phone, through the Intentic Device app on it: see its screen, use the apps they allow, read the folders they picked and the notifications they share. Use when the user says "my phone", names this phone, or the task needs something only the phone has (an app with no web version, a code sent by text or notification, a photo or a file on it).
---

${tools}

## Android specifics worth knowing

- **Package names are how apps are named here.** `apps` lists them (`com.whatsapp`, `com.google.android.gm`). Use the
  package with `open` and `ask_access`, and the label when you talk to the person.
- **The screen in front is the only screen.** Unlike a browser's tabs, there is no working in the background: opening
  an app takes the person's screen from whatever they were doing. Say what you are about to open before you open it.
- **Back is not undo.** `device` `back` leaves a screen; in a form it may throw away what was typed. Read the screen
  again after it.
- **Keyboards cover the bottom of the screen.** After typing, the button you want may be hidden under the keyboard:
  `device` `back` closes the keyboard first, then list the elements again.
- **Lists load as they scroll.** If what you look for is not in `ui_elements`, scroll the list (`ui_act` `scroll_down`
  on the list's ref) and list again, rather than concluding it is not there.
- **Some screens are protected.** Banking apps and password fields show black in a screenshot by Android's own rule.
  `ui_elements` still names their buttons; their contents are the person's to read out, not yours to work around.
- **Permission dialogs belong to the person.** A system dialog asking to allow a permission, install something or
  change a setting is theirs to answer: tell them it is there and wait.
