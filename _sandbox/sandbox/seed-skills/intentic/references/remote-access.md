# Reaching the workspace from a phone or another computer

## The link

The app is **https://app.intentic.dev**. The owner opens it in any browser, on any device, and signs in with the
same Google account; it lists their sandboxes and talks to each sandbox directly. Nothing else is needed for
remote access, and no port has to be opened: every sandbox, hosted or on the owner's own machine, dials out to
intentic's ingress and is reached at its own address, `sandbox-<id>.sbx.intentic.dev`, shown as **Sandbox URL** on
Sandbox ▸ Overview. A sandbox on the owner's own computer answers only while that computer and its container are
running.

## On a phone

- Below 768 px wide the app switches to a phone layout: full-screen views under a bottom tab bar, **Chat**,
  **Agents**, **Review** (not shown to guests) and **Menu**.
- The app ships a web manifest (standalone display, with **Chat** and **Agents** shortcuts), so the browser's own
  Add to Home Screen / Install app puts it on the Home Screen as an app. There is no install button inside the app.
- Push notifications on iPhone need that Home Screen install first. The phone's Menu says **Add to your Home
  Screen to get notified** when the browser cannot receive push; Settings ▸ Notifications says the same.
- Setting up a new sandbox needs a terminal and Docker on the target machine, not the phone; on a phone, setup
  offers to email the link back to that screen.
- The repository also holds Android and iOS shells that load the same URL. Do not promise a store listing; the
  web app on the Home Screen is the route that always exists.

## The desktop app

**Intentic** for Windows and Linux (no macOS build yet), from intentic.dev. It sets up and runs a sandbox on that
computer and opens the same app.intentic.dev in its window; from the tray it starts, stops, updates, rebuilds and
removes the sandbox and shows its logs. It is not needed to reach a sandbox from another computer: any browser
signed in at app.intentic.dev reaches the same sandbox.

Its window cannot receive push, so the app does that part itself: while the owner is in another app it shows the
system's notification when an agent needs them or a turn they started finishes (pressing one opens that
conversation), and its tray and taskbar icon carry the same count and marks the browser tab does. Both are on by
default and switched in Settings ▸ Notifications; the system's own Do Not Disturb and per-app notification settings
silence them like any other app's.

## Other people

**Sandbox ▸ Access** (`/sandbox/access`): the owner invites by email and picks a role under **Invite as**:
**Viewer** (watches everything, changes nothing), **Collaborator** (drives agents and reviews work; landing and
publishing become requests), **Writer** (changes files in the folders named for them), **Maintainer** (operates
everything the owner can), **Guest** (talks only to the assistants that work in the areas named). **Areas**
narrows a person to folders. The invite link is emailed, lasts 7 days and must be accepted by that address,
signed in with Google. Only the owner invites or changes roles.

The same tab holds **Require a passkey to open this sandbox**, API tokens (**Mint token**), the list of signed-in
browsers with **Sign out everywhere**, and who is connected right now.

## Not a way into the workspace

A shared conversation link is a read-only page. Files in `/work/public/` are public on the internet at the
sandbox's own public address. Neither lets anyone drive the sandbox.
