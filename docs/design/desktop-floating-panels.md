# Floating panels in the desktop app

A panel the page pops out is the page's own second window: the desktop app builds it natively and drives it by
the same link protocol as its title bar, and the page notices nothing else.

## The problem

The SPA floats its chat, terminal and preview into `/floating/<panel>` with `window.open`. In a browser that is
a popup: a second copy of the app that shares the first one's origin storage, so the two arbitrate who draws
the panel over `BroadcastChannel` and a Web Lock, and the chat projection follows (`chat-window-state.md`).
The desktop app's workspace webview answered every `window.open` by sending the URL to the default browser,
which is correct for a provider's token page and wrong for this one: popping the chat out of the app opened it
as a tab in the browser, beside an app whose panel had just collapsed.

## What was chosen

`window.open` on a same-origin `/floating/<panel>` URL is answered with a Tauri window of the app's own
(`windows.rs`, `page_window` and `show_floating`), labelled `floating-<panel>`, built with everything the
workspace window has and at the frame the page passed in the features. The call is denied, so the page sees
`null` exactly as it would from a refused popup and keeps the panel until the new window announces itself. What
a page may do to its own window only when its script opened it (close, raise, resize) it does by link:
`intentic://window?do=close|raise|fit`, and the link now carries the label of the window it came from
(`Source::App { window }`), so the app answers on that window.

## What it was chosen over

- **`NewWindowResponse::Allow`**, letting the webview open its own popup. On WebView2 that is a bare popup the
  app does not own: a platform frame around a page told to draw its own bar, no init script (so the page would
  not know it was in the app at all), no place in the tray or the close logic, and nothing on WebKitGTK unless a
  related view is created anyway. It solves the browser tab and creates a window that is not the app's.
- **`NewWindowResponse::Create`**, handing back a webview built in the callback. It has to be built inside the
  webview's own event, which is the WebView2 re-entrancy the navigation handler already spawns to avoid, and it
  gains nothing over building the window a moment later that the page could observe.
- **A synced picture instead of a window**: teleporting the panel's DOM or mirroring its state into a second
  webview from Rust. The web package abandoned exactly this bet for the browser (its README, "A panel in a window
  of its own") because it made one copy of the app the owner and every other a photograph; the desktop has no
  reason to bring it back when the two webviews already share a browser profile and the browser's own protocol
  crosses between them unchanged.
- **Relying on `window.close()` and `window.focus()` in the webview.** Chromium and WebKit allow both only for a
  window the script opened; whether a given wry version forwards a script's close request to the window is a
  platform detail that has changed before. The link is the protocol the bar already uses and is deterministic on
  every platform, and the page keeps the DOM call for the browser, where it is the right one.

## What it costs

- A second window on screen, by the page's request. The app's rule that its own faces take turns in one window
  stands; a floating panel is not a face of the app, it is a panel of the page, and the browser gives the same page
  the same second window.
- Per-window bar state (`Chrome`, keyed by label) in place of two statics, and a `Destroyed` handler that forgets
  it, so a panel popped out again after being closed is judged by its own grace.
- `desktop.ts` had to become importable where no deploy config exists, because `floating.ts` now imports it and
  node-environment suites import `floating.ts`; the download links moved to `desktopDownloads.ts`.
- A page older than the app never asks (its `window.open` goes to the browser as before); an app older than the
  page still sends the panel to the browser. Neither combination is worse than it was.
