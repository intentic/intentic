# Reaching the workspace from a phone or another computer

## The link

The app is **https://app.intentic.dev**. The owner opens it in any browser, on any device, and signs in with the
account they set the sandbox up with: Google, or a six-digit code mailed to their address on any domain. It lists
their sandboxes and talks to each sandbox directly. Nothing else is needed for remote access, and no port has to be
opened: every sandbox, hosted or on the owner's own machine, dials out to intentic's ingress and is reached at its
own address, `sandbox-<id>.sbx.intentic.dev`, shown as **Sandbox URL** on Sandbox ▸ Overview. A sandbox on the
owner's own computer answers only while that computer and its container are running.

## On a phone

- Below 768 px wide the app switches to a phone layout with no tab bar. Home is the **Agents** board, with a rail of
  icons down its left: the sandbox's logo at the top opens the **Menu** (switch sandbox, what it needs, who is
  here), then every section, **Terminal**, **Sandbox** and **+** to add a capability, and at the foot the avatar
  (Settings, sign out). The board shows only the lanes with something in them. A chat opens full-screen from its
  card on the board; every screen has a back arrow to the board. Geek metrics and the usage readouts under the
  composer are desktop-only.
- The app ships a web manifest (standalone display, with **Chat** and **Agents** shortcuts), so the browser's own
  Add to Home Screen / Install app puts it on the Home Screen as an app. There is no install button inside the app.
- Push notifications on iPhone need that Home Screen install first. The phone's Menu says **Add to your Home
  Screen to get notified** when the browser cannot receive push; Settings ▸ Notifications says the same.
- Setting up a new sandbox needs a terminal and Docker on the target machine, not the phone; on a phone, setup
  offers to email the link back to that screen.
- The repository also holds Android and iOS shells that load the same URL. Do not promise a store listing; the
  web app on the Home Screen is the route that always exists.
- That is the editor on a phone. Letting the agent WORK on the phone (its screen, apps, folders, notifications) is a
  different thing: the Intentic Device app from intentic.dev/phone, paired by scanning the QR code on an Android phone
  card in Capabilities. It is Android-only.

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

**Sandbox ▸ Access** (`/sandbox/access`) has four tabs: **People**, **Sign-in**, **Programs** and **Allowed**,
each at its own `?section=`. **People** (the first) shows everyone as tiles, the way Personas and Models do: the owner first,
then one tile per person with a word for what they can do (Can see, Runs agents, Edits, Chats, Manages) and a dot while
their invite is out. **Add person** asks for an email address alone. The person starts read-only: they see the
workspace, run no agents and may use no connection or secret, and the invite goes out at once. Their panel then opens
under the tiles (as does any tile pressed, or a link with `?open=<email>`), and every change in it saves as it is made:

- **Agents**: Off (they watch), Chat with assistants (only the assistants that work in their areas, nothing else of the
  sandbox), or Run agents (their agents' work lands only when somebody who manages the sandbox lands it).
- **Can see**: the whole workspace or some **Areas**. Their agents work inside the same folders.
- **Can edit by hand**: nothing, everything they see, or some of their areas. This is separate from agents, so a person
  can see everything and edit one folder, or edit by hand without running agents.
- **Connections and secrets**: all, or only the ones ticked. Enforced by the sandbox, not told to the model: what is left
  out is never loaded into their conversations, and every use of it is refused with no approval card that could release
  it. A conversation can use only what every person who has written in it may use. Docker, a VPN, a network disk and a
  local model hold no credential to withhold, so they are listed as always available.
- **Manage the sandbox**: everything at once (land work, publish, settings, connections), the old Maintainer.
- **Sign in with an emailed code**: on by default for an address outside Gmail; Google and passkeys always work.

An answer the sandbox would refuse (chatting with no area, a narrowed scope with nothing ticked) waits in the panel as
**Not saved** with the reason. The panel's header holds **Resend** for a pending invite and **Remove**. The invite link
lasts 7 days and must be accepted by that address. Only the owner adds people or changes their access.

A sandbox older than email sign-in says it needs an update before it accepts one. Right after a first email sign-in
the app suggests a passkey: passkeys belong to the sandbox itself and keep working while app.intentic.dev is down,
which email sign-in does not.

**People** also holds the AI notice and, while anyone else is connected, who is here now. **Sign-in**
(`?section=sign-in`) holds passkeys, **Require a passkey to open this sandbox** and its recovery codes, and the
signed-in browsers with **Sign out everywhere**. **Programs** (`?section=programs`) holds API tokens (**New token**),
linked sandboxes (**New link**, and the Allow or Decline of a task one handed over, counted on the tab), and a count
of the other ways in (webhooks, gated workflows, CI, paired machines). **Allowed** (`?section=allowed`) lists what
conversations were allowed past their persona or area and the sandbox-wide yeses, each with its own Revoke, counted
on the tab. A member below maintainer sees People and Sign-in only.

## Not a way into the workspace

A shared conversation link is a read-only page. Files in `/work/public/` are public on the internet at the
sandbox's own public address. Neither lets anyone drive the sandbox.
