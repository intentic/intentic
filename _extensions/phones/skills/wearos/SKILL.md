---
name: wearos
description: Use "${id}", the user's OWN Wear OS watch, through the Intentic Device app on it: its screen, its tiles and the apps they allow. Use when the user says "my watch", names this watch, or needs something only the watch has (a watch app they are building or testing, a tile, something on their wrist).
---

${tools}

## This is a watch, not a phone

The tool table above is every phone's. On a watch `describe` says `form: "watch"`, and some of those tools are not
there at all:

- **No folders and no notifications.** Wear OS has no document picker to hand a folder over with and no screen to
  switch notification access on, so `list_dir`, `read_file`, `write_file`, `trash_file` and `notifications` are not
  listed. A watch's notifications mostly mirror the phone's: when a code arrives, read it on the phone's own card.
- **No browser.** A link `open`ed on the watch opens on the phone it is paired with. Open apps by package instead.
- **No Quick Settings tile.** The person pauses you from the Intentic tile beside the watch face, or from the app.

## Wear OS specifics worth knowing

- **The screen is small and usually round.** Corners of a screenshot are outside the screen. Work from
  `ui_elements` refs; a coordinate near an edge may land on nothing.
- **Getting around.** `device` `back` is the swipe in from the left edge. `device` `home` goes to the watch face.
  From the watch face the tiles sit to the left and right (swipe), notifications below (swipe up), quick settings
  above (swipe down). The app list opens with the side button, which `home` from the watch face also reaches.
- **Lists turn with the crown.** Scroll a list with `ui_act` `scroll_down` / `scroll_up` on its ref, and list the
  elements again: a watch shows three or four rows at a time.
- **Tiles are readable.** `ui_elements` names a tile's buttons ("Timer 5 minutes"), so a tile can be used like any
  screen, in an app the person allowed.
- **The screen dims within seconds.** A dimmed (ambient) watch shows a simplified face. A tap wakes it; take a fresh
  screenshot after.
- **Typing is a last resort.** A watch keyboard is a few keys at a time. Prefer `ui_act` `set_text` on a field, and
  prefer a phone or a computer for anything long.
- **The battery is small.** Do what was asked and stop; the app lets go of the connection after five quiet minutes
  unless the person set it to stay connected.

## When the watch is not paired yet

The person scans the watch card's QR code with the phone the watch is paired with: Intentic Device on that phone sends
the code to the watch, and the watch asks them to confirm. If they have no phone with the app, and the watch is also
attached to one of their connected computers over adb (its `android_devices` lists it with `form: "watch"`):

1. Install the app on the watch through that computer: `android_install` with the APK from intentic.dev/watch.
2. Ask the person to press `Connect` on this card, choose "Can't scan it?", and copy the code on that computer.
   Read it with the computer's `clipboard` tool; never ask for it in chat.
3. Open it on the watch: `android_shell` `am start -a android.intent.action.VIEW -d 'intentic-device://pair#<code>'`.
   The watch shows the sandbox's address and the person confirms there. Nothing pairs without that tap.

"Tap, swipe and type" also needs the app's accessibility service on the watch: Settings ▸ Accessibility, where Wear OS
may list it as `dev.intentic.device.touch.TouchService`, then Enable and Yes. That switch is the person's: tell them
where it is rather than turning it on yourself.
