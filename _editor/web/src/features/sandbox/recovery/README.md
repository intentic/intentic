# recovery

What the editor does when the platform is down or has forgotten an account's sandboxes: it opens them from what this device remembers, and has the platform take back the ones it lost.

- **What this device remembers** (`client/directory/deviceDirectory.ts`): per account, every sandbox the platform last listed, by its
  normalized address, with its name, logo, role and last-seen time, never a token. A list never makes it forget: a
  sandbox the list lacks is kept and marked missing, since a platform that forgot it lists nothing. It is let go of
  when the platform says it was deleted or is someone else's (`rememberSandboxes.ts` asks `sandbox.lookup` after each
  list that lacks one), when its owner deletes it here, after a month missing, or on an explicit sign-out. A refused
  session's teardown (`lib/authLifecycle.ts`) keeps it, since that is exactly when it is needed. (2026-10-26) For an
  owned sandbox that may run on its owner's computer it also keeps where it answers there: the 12-hex id its loopback
  port derives from, read off the connect token when listed (`rememberSandboxes.ts` `localIdsOf`; the token itself is
  still never kept), and the certified loopback name the list gave.
- **Which database.** Each list is remembered with the platform's identity (`GET /api/identity`). A list from another
  database than the one remembered is a reset, and the recovery screen says so.
- **Never empty** (`router/index.ts` `requireSetup`): a list that offers nothing to open while this device remembers
  sandboxes of the account's own goes to `/recover`, not onboarding. A list the platform could not give goes to the
  outage screen; it used to leave the page blank. A session check that does not answer within ten seconds does too.
- **Recovery** (`/recover`, `Recover.vue`, `useRecovery.ts`): each missing sandbox is probed at `/health` and the ones
  that answer are looked up in one question. An unknown one of the account's own is offered back. Reconnect gets a
  daemon session (a Google sign-in, a passkey, or the platform's identity assertion for an account that signs in by
  email code), an adoption ticket from the platform, and has the daemon
  relink (`POST /platform/relink`), which has the platform make the row again from the daemon's own token and grant. A
  daemon too old to relink, or a platform that cannot vouch (no reachability grants), is recorded by its address alone
  (the setup screen's attach). A share is its owner's to bring back; a deleted sandbox stays deleted.
- **Direct mode** (`directMode.ts`, `DirectSandboxes.vue` on the outage screen): a remembered sandbox opens without
  the platform. The window signs in as the remembered account, whole, so presence, analytics and the persisted cache
  read as before, and the remembered list is seeded into the list's own cache entry, which every reader of the list
  reads. A device that remembers no account names the reader by what the sandbox itself knows (`accountFromProof`): a
  daemon session this browser already holds there, or else the reader picks Google's sign-in or a passkey registered
  with that sandbox. The passkey is the one way in for an account that signs in by email code, since the platform that
  vouches for its address is the thing that is down; its session is kept under the id the window opens the sandbox by. Nothing in the shell changes; what needs the platform (sharing, billing, a hosted machine's power) fails as it
  does offline, and a card says why. The next session check the platform answers ends it, and the list it answers
  replaces the remembered one. (2026-10-26) A sandbox on this very computer is dialled here before its tunnel, as it is
  with the platform up: the remembered row carries its certified loopback name, and endpoint selection takes the
  remembered loopback id where the row has no token (`client/endpoint/useEndpoint.ts`), so an outage of the edge as well
  as the platform still leaves it open. Before, direct mode reached every sandbox through its tunnel alone.
- **This computer's own sandboxes** (`app/environments/thisComputer.ts`): in the desktop app on a computer that runs
  sandboxes (the app says `machineFace`), the outage screen, the direct-mode card and a card over a sandbox that stopped
  answering with the platform also offer "Use this computer's sandboxes", the link (`intentic://machine-face`) that turns
  the window into the app's own copy of the editor on them, which needs neither the platform nor the internet.
- **A sandbox's own address** (`/open?url=`): the daemon sends a browser that opened its address here (its `GET /`).
  A listed sandbox opens; an unlisted one goes to recovery; with the platform down, the outage screen offers it first.
- (2026-10-02) Before this, the editor trusted whatever the platform answered: an empty list from a database that had
  forgotten an account read as a new account, sent its owner to onboarding, and nothing on the device knew where their
  sandboxes were. Rejected: keeping the sandbox list in the persisted query cache, whose rows carry connect tokens.

## Key files

- [client/directory/deviceDirectory.ts](../../../client/directory/deviceDirectory.ts) — what this device remembers per account, and the merge every list goes through.
- [rememberSandboxes.ts](rememberSandboxes.ts) — remembers each list the platform answers, and asks about what it lacks.
- [useRecovery.ts](useRecovery.ts) — probe, look up, sort, and the Reconnect sequence, every effect a dependency.
- [directMode.ts](directMode.ts) — opening a remembered sandbox without the platform.
- [Recover.vue](Recover.vue) — the recovery screen.
