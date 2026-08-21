# @intentic/ext-google-workspace

Google Workspace as a place the agent works: one connected account gives it Gmail, Calendar, Drive, Docs,
Sheets and Contacts, and can wake it when mail arrives or a meeting is about to start.

## Responsibilities

- Declare the card an owner connects a Google account with: two ways to authenticate, and a read-only switch
  that is enforced twice over.
- Turn a durable credential into the hour-long access token every request rides, and cache it between commands.
- Give the agent one command, `gw`, covering all six services.
- Watch a connected account for new inbox mail and imminent calendar events, and turn those into agent turns.

## Key files

- [intentic-extension.json](intentic-extension.json): the card, its fields and its setup guide, plus the
  listener, the process and the `bin` this extension contributes.
- [src/google/accounts.ts](src/google/accounts.ts): what a connection IS, read either off the agent's
  environment or off a stored config; the one place a half-filled card becomes a sentence rather than an
  absence.
- [src/google/session.ts](src/google/session.ts): the access token, minted once and reused between `gw`
  invocations, keyed so a rotated credential can never be answered from the old one's cache.
- [src/cli.ts](src/cli.ts), the router: which account, whether it may write, and what a failure looks like.
- [src/watch/poller.ts](src/watch/poller.ts), the watching half: Gmail's history cursor and the calendar's
  look-ahead window.
- [skills/google/SKILL.md](skills/google/SKILL.md): what the agent is told about all of it.

## How it fits

A **daemon-side** extension with no views: a capability card, an agent CLI, a listener and its process. The
reconcile/status/health shell is `@intentic/connector-runtime`, shared with the chat connectors; what lives
here is only what Google is.

It ships like the messaging gateways: manifest baked into every image so the card is always visible, runnable
tree in the standard image's `messaging` pack. That is one decision, not two: the manifest promises both a
`bin` and a process, and the daemon's readiness check is all-or-nothing per extension, so shipping `gw` from
the build context while the watcher came from the pack would make the watcher's absence invisible on a core
image instead of stated on the card.

## Conventions & gotchas

- **A naive time means the calendar's timezone, never the container's.** The sandbox runs in UTC and the owner
  does not. Writes send `{dateTime, timeZone}` and let Google convert; only the query parameters that must be
  absolute get an offset computed here.
- **The read-only switch is enforced in two places on purpose**: narrower scopes at Google, and a `writes`
  flag per command here. Google's refusal alone would read as something broken rather than as the setting the
  owner chose.
- **`invalid_grant` is this integration's characteristic death.** An OAuth consent screen left in `Testing`
  issues refresh tokens that expire after seven days, and Google's own message for it says "Bad Request". The
  sentence in [src/google/token.ts](src/google/token.ts) is the fix, spelled out; do not soften it.
- The watcher advances Gmail's cursor **before** dispatching. A wake that failed to reach an agent is visible
  in the activity feed; the same mail arriving every minute for an hour is not something anyone can switch off.
- `bin/gw` is a launcher over `dist/`, unlike the other agent CLIs in this repo, which are plain ESM with no
  build step. The same auth and request layers serve the watcher, and a second hand-maintained copy in
  JavaScript is exactly the drift that costs.
