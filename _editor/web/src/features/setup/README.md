# setup

The flows that make a sandbox and get it running, and the pieces that draw them. The page they used to live on,
`/setup`, is gone (2026-10-26): a new sandbox is made, and one left unfinished finished, on Home, in a dialog and then a
tile of its own whose run shows in the chat's place (`features/home/newSandbox/`, which says why). Nobody is moved out of
Home to do it. `/setup` is a redirect now (`router/setupRoutes.ts`), and `/start/hosted`, the site's way in for every
"Start in your browser", is the cloud entry (`router/hostedEntry.ts`): signed out it signs in and comes back to itself;
signed in it opens the reader's own cloud sandbox when they have one (and finishes one left unfinished), and only
otherwise lands on Home's ask. So a bookmark, an emailed link, an older desktop app or the site lands on Home's ask for
the same thing:

| Old address | Lands on |
|---|---|
| `/setup` | `/home?add=sandbox` |
| `/setup?sandbox=<id>` | `/home?add=sandbox&finish=<id>` |
| `/setup?machine=hosted` (`elsewhere=1`) | `/home?add=sandbox&machine=hosted` |
| `/start/hosted?tier=<id>` | `/home?add=sandbox&machine=hosted&tier=<id>` (a tier always means a new machine) |
| `/start/hosted`, with a cloud sandbox of one's own | that sandbox, on the screen this window last left it on (woken if its machine stopped) |
| `/start/hosted`, with one left unfinished | `/home?add=sandbox&finish=<id>&machine=hosted` |

`found=` (what the desktop app found signed in on this computer) rides along every time. The shell's gate, which still
answers `/setup` for an account with nothing to open, is settled to Home's first run (`app/environments/nothingToOpen.ts`),
and a guard test fails on any navigation to `/setup` written anywhere else (`router/noSetupNavigation.test.ts`).

- **The press** (`add/useAddSandbox.ts`): a name, who handles the code (hands-off or hands-on, carried to the machine as
  its settings `mode`; a link from intentic.dev/desk only preselects hands-off) and where it runs, one press for what
  starts in one press (this computer
  in the app, a connected machine, a machine of ours with room), and "More ways" in the same form (`add/AddSandboxForm.vue`):
  - **A command for a server** (`add/useAddCommand.ts`, `add/AddSandboxCommand.vue`): the row is made, its code minted,
    and the command shown to copy (each shell, or the compose file), with the reader's own Cloudflare zone riding it if
    they choose one. The wait reads the machine's account of its run (`flow/useCommandWait.ts`): the code redeemed, the
    step it is on, and verbatim what broke. A phone gets the link mailed to the computer that has a terminal. A code
    lives 30 minutes: once it runs out with the command still on the page, the command is taken off and a fresh code
    minted in its place, with a retry if that fails (`add/useCodeRenewal.ts`), unless a run holds the code (claimed, or
    reporting without a failure), whose reports a fresh code would orphan. (2026-10-23: the page kept copying a code the
    platform refused, under a nudge saying it was safe to run again.) The compose file's bootstrap saves the claim to
    `intentic.env` beside the file, moved into place only once the claim succeeded, never to the folder's `.env`.
  - **One already running** (`add/useAddAttach.ts`, `add/AddSandboxAttach.vue`): the address is probed from this browser
    (`setupAttach.ts`), and the row made under the typed name only once the sandbox there let this account in, so a typo
    leaves nothing behind. An address this account already lists opens that sandbox instead.
  - A machine of ours it cannot have right now says why under the picks: a Google sign-in to link (`SetupNeedsGoogle.vue`),
    the free one already in use (naming the reader's own cloud sandbox that holds it, with a press into it, and the way to
    buy another, Settings ▸ Billing), none free, or switched off for the account.
- **Finishing one left unfinished** (`resume`, Home's `?finish=<id>`): the row it has, never another. A machine of ours
  already on it is waited on, and one is started on it where the address asked for one (`machine=hosted`, the failure
  mail's second link); otherwise a fresh code is minted, run by the app on this computer where there is one, and shown as
  the command to run anywhere else. Every "Finish setting up" press goes there (`models/sandbox/finishOnHome.ts`).
- **The app's install on this computer** is handed over out of sight (`intentic://setup?…&stay=1`) and drawn here from
  the app's reports (`DesktopSetupProgress.vue`, `desktopSetup.ts`, `desktopRun.ts`). What it asks of the reader (its
  go-ahead, a restart, a sign-out, a retry) is answered on the same page: an app that takes answers from the page
  (`desktopTakesProcesses`) is sent them as `intentic://process-act` for `sandbox-setup:<id>`
  (`app/environments/processes/processReport.ts`); only an older app keeps the press that opens its card on This computer. A slow
  download, or a restart the reader would rather not make, offers a machine of ours on the same row instead, which first
  sends `intentic://setup-stop` so the PC stops downloading for an address the machine takes over.
- **A press on a connected machine** runs `ic sandbox connect` there and streams its output back
  (`flow/useSetupOnMachine.ts`); the page reads those lines with the engine the desktop app reads its own install with
  (sandbox-run's `setup-progress`), in `progress/`, and draws them with `<StagedProgress>` (`SetupMachineProgress.vue`).
  On Home's page (`page`) the card drops the heading and the estimate the page's header already says, and its steps
  take the page's type; the app's install (`DesktopSetupProgress.vue`, `inPlace`) and a machine of ours' steps
  (`HostedWaitSteps.vue`) do the same, so the header and the lane never say the same figure twice. How far each lane
  has got is read once more where the run lives, for its tile and This computer (`features/home/newSandbox/newSandboxGauge.ts`).
- **A machine of ours** (`flow/useHostedLane.ts`): provisioned on the row (on the tier the address named), waited on with
  its steps (`hostedWait.ts`, `HostedWaitSteps.vue`), started over where that can help.
- **The funnel's milestones**: `sandbox_add_started` at the press, `sandbox_hosted_created` once per machine of ours the
  platform made (with its `tier`; not the wait's own rebuild, and also for a reader who went elsewhere meanwhile), and
  `sandbox_connected` at the row's first check-in, with `machine: hosted | own`. The row is marked as being set up here
  until that check-in is counted (`models/sandbox/live/settingUp.ts`), which lets product analytics' sandbox gate count
  them: the gate holds events while the open sandbox's own analytics switch is unread, and a sandbox still being set up,
  already the open one, cannot be read. (2026-11-23) From the gate's arrival on 2026-10-13 until then,
  `sandbox_hosted_created` fired zero times and `sandbox_connected` about once a week.
- **The row and the watch** (`flow/useSetupRow.ts`, `flow/useRegistryWatch.ts`): the row is made only on the press and
  deleted if refused before any machine got its code; the registry is read every few seconds, and the row opens once it
  reports in (a machine of ours once it is ready to use). It is selected unless Home's reader went back to another
  sandbox's chat, and the run waits out its first start (`add/AddSandboxOpening.vue`) so the connecting and starting
  gates are never shown. Once open, its reader lands on Home, or on Sandbox ▸ Models when the desktop app found AI tools
  signed in on this computer (`lib/foundOnComputer.ts`).
- **A phone, and a guest of a box,** have no Home to stand on: they get the same form and run in a dialog over the
  current place (`add/AddSandboxDialog.vue`), which takes `finish`, `machine` and `tier` from Home's address as the
  shell hands the ask over.

## Key files

- [add/useAddSandbox.ts](add/useAddSandbox.ts) — the press, its offers, "More ways", finishing one left unfinished.
- [add/useAddSandboxHere.ts](add/useAddSandboxHere.ts) — that press wired to this window's platform, app and credential.
- [add/AddSandboxForm.vue](add/AddSandboxForm.vue), [add/AddSandboxRun.vue](add/AddSandboxRun.vue) — the form and what the press started.
- [../../client/sandbox/sandboxName.ts](../../client/sandbox/sandboxName.ts) — the name a new sandbox gets, numbered past the account's own.
- [flow/useSetupOnMachine.ts](flow/useSetupOnMachine.ts) — the press on a connected machine.
- [progress/setupRunProgress.ts](progress/setupRunProgress.ts) — that press's output read as steps.
- [flow/useHostedLane.ts](flow/useHostedLane.ts) — the machine of ours on the row: provision, wait, restart, hand back.
- [desktopRun.ts](desktopRun.ts) — the desktop app's install as its reports tell it: how long each kind of app may go
  unheard, the image download's figures, and when a download is slow enough to offer a machine of ours instead.
- [../../router/setupRoutes.ts](../../router/setupRoutes.ts) — the old addresses, landed on Home.
