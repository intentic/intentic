# setup

The `/setup` page: it makes the sandbox row a visit sets up, decides by itself where that sandbox runs, and opens its workspace once the sandbox answers.
Since Home became the first screen (2026-10-25) a browser account with nothing to open is not sent here: it lands on
Home's first run, which makes its first sandbox with the Add sandbox dialog below. This page is where an unfinished
setup of the reader's own is resumed, where "More ways" and cloud pricing lead, and what the desktop app opens.

- **Starting from cloud pricing** opens `/start/hosted` (`hosted/HostedStart.vue`), outside the workspace gate. It reads
  the account's cloud machines and the chosen tier's offer without minting a draft. Sign-in returns here with the
  cloud choice intact; a local sandbox never substitutes for that choice. Create commits an account-scoped UUID,
  reused by the platform across retries, then hands the named row and tier to `/setup?machine=hosted`. Existing cloud
  machines use that same progress and readiness flow. Google linking and checkout return to this entry, and a paid
  machine is provisioned against the selected tier's allocation rather than the free one. Billing can complete here
  before the account has a working workspace.

- **What an arrival does by itself** is decided in one place, `arrivalFor` in `setupArrival.ts`: the desktop app hands
  the setup code to itself (`local`), a browser starts a machine of ours (`hosted`), and the picker (`choose`) survives
  only where the surface's own answer is unavailable or was asked for. An account that removed a sandbox it can still
  restore (the platform's trash, or a trash that could not be read) starts nothing by itself: the picker waits for a
  click, since the app once installed a new sandbox seconds after its reader removed the last one. Nor does an account
  signed in after another one in the app (`client/auth/appAccounts.ts` keeps a fingerprint of each account the app has
  been signed in as, which a sign-out leaves): switching accounts is not having just installed the app, and on
  2026-10-21 a sign-in as a second email with no sandbox set one up on the reader's PC unasked. Only the app's first
  account gets this computer by itself.
  `flow/useSetupArrival.ts` takes the answer; the other flows are the lanes it takes it on.
- **A project.** The desktop app makes a folder's sandbox itself, from the folder's own window, and this page sees it
  only when nobody is signed in: the app parks the folder and opens `/setup?project=<folder name>&machine=mine`, and
  `setupProjectOf` derives the folder's name in the sandbox (`/work/<dirName>`) once. Inside the app a project always
  runs on this computer, handed to the app with `project=` the moment its code mints: a machine of ours three to five
  minutes away was the wrong answer to a folder's window (2026-10-05). A machine of ours is the project's rung only
  when asked for by name (`?machine=hosted`), started for the row and asked for with the folder's name (the platform's
  `hostedProvision` with `project`, `flow/useHostedLane.ts`), or picked in the picker where the platform's machines can
  hold one (`hostedOffer.projects`). Either way the workspace opens on the folder (`openOnProject`), not on the `/work`
  around it.
- **The folder reaches a machine of ours through the app.** Once the machine answers (`flow/useRegistryWatch.ts`),
  `hostedProject.ts` mints a sync pairing on it the way the Desktop sync card does and opens
  `intentic://sync?url&pair&name&project&sandbox` inside the app, which copies the folder it parked into
  `/work/<dirName>`; only then does the workspace open. A hand-over that fails keeps the page with a notice, and the next
  registry reading tries again. Outside the app nothing is handed over.
- **What the page says** about a project, on either machine: the folder is copied into the sandbox, agents work on the
  copy, and their changes come back when the owner presses "Bring back changes" in the folder's window.
- **What this computer is already signed in to.** The desktop app opens the page as `/setup?found=claude,codex`, the
  providers it found signed in on the computer. `lib/foundOnComputer.ts` keeps the list in the tab's session storage as the
  router first sees it, since a signed-out app's sign-in comes back at `/` without the query, and the finished setup
  opens Sandbox ▸ Models (`/sandbox/models?found=…`) instead of `/`, which offers each one as a single press. No login is copied: the sandbox signs
  in afresh, and the browser already signed in answers it.

- **Where it runs on the owner's side.** The run card's facts are its address and, when a computer of the owner's is
  already connected and its card has "Manage sandboxes on this device" on, a "Runs on" row: this computer's own way
  (the app's button, the installer, the command) or that machine (`flow/useSetupOnMachine.ts`). Picking is only a pick;
  the card holds one button for it, so a stray click starts nothing. A machine whose switch is off is not offered
  (`setupDoors`, read off the device row's `manages`): its agent would refuse the press. The app's install has a Cancel
  beside its button, sent to the app as `intentic://setup-stop` (the app stops the run, or gives up a setup still
  waiting on the PC); a press on a machine has no stop, since the machine's flow takes none, which is why choosing it
  is a separate step from starting it.
- **What a press on a machine shows.** The machine runs `ic sandbox connect` and streams its output back. The page
  reads those lines with the engine the desktop app reads its own install with (sandbox-run's `setup-progress`), in
  `progress/`, and draws the run with `<StagedProgress>`, the card every long run on a machine uses: the steps, a bar
  sized by them, the time left, and the raw output behind "Show log", which opens by itself when the run fails.

- **Adding a sandbox** is not this page. "Add sandbox" (the switcher, the home rail, the phone's Menu and the command
  palette) opens a dialog over the current place instead (`add/AddSandboxDialog.vue`, `add/useAddSandbox.ts`), for the
  first and every later sandbox. Signed-out home first asks for sign-in, then returns with this dialog open: a
  name and where it runs (this computer in the app, a connected machine, a machine of ours with room), then one press.
  It runs this page's own flows on the row (`useSetupRow`, `useHostedLane`, `useSetupOnMachine`, `useRegistryWatch`),
  so `/setup?sandbox=<id>` resumes the same run, and the getting-started ring's "Finish setting up" reaches it once the
  dialog is closed. Once the sandbox reports in it is selected behind the dialog, which stays up through its first start
  (`add/AddSandboxOpening.vue`, the daemon's boot steps) and closes only once the workspace is on screen, so the
  connecting and starting gates are never shown. Opened from Home (the first sandbox always is), the
  dialog closes onto Home with the new sandbox selected, once its home conversation is on screen
  (`models/home/homeChat.ts` `homeShownFor`), and that conversation is where the first session starts; a finished
  setup here lands there too (`landingAfterSetup`), a folder's project inside its sandbox. Opened from inside a
  sandbox, the workspace opens on the new one's full-screen chat (`/chat`). The dialog draws the run itself and links to no
  `/setup`: that page cannot pick up a press on a machine mid-stream, so it showed only the install picker. Every other way (the command, the installer, an own domain) is "More ways", `/setup?elsewhere=1`,
  which skips the "You already have a sandbox" question and opens the picker. The shared add action and its return
  address live in `models/sandbox/addSandbox.ts`.

## Key files

- [setupArrival.ts](setupArrival.ts) — what an arrival does by itself, a project's included, and the folder's name in the sandbox.
- [../../client/sandbox/sandboxName.ts](../../client/sandbox/sandboxName.ts) — the name a new sandbox gets, numbered past the account's own; the desktop app's folder dialog names one the same way.
- [flow/useSetupArrival.ts](flow/useSetupArrival.ts) — reads the offers and the row, decides the arrival and takes it.
- [flow/machineLadder.ts](flow/machineLadder.ts) — the picker's rungs, and which of them a project may have.
- [flow/useSetupOnMachine.ts](flow/useSetupOnMachine.ts) — the "Runs on" pick and the press on a connected machine.
- [progress/setupRunProgress.ts](progress/setupRunProgress.ts) — that press's output read as steps, in this page's words.
- [flow/useHostedLane.ts](flow/useHostedLane.ts) — the machine of ours on the row: provision, wait, restart, hand back.
- [hostedProject.ts](hostedProject.ts) — the hand-over of a hosted project's folder to the desktop app.
- [desktopRun.ts](desktopRun.ts) — the desktop app's install as its reports tell it: how long each kind of app may go
  unheard (one that heartbeats, one that reports only on a change), the image download's figures, and when a download
  is slow enough to offer a machine of ours instead. Taking that offer inside the app first sends `intentic://setup-stop`,
  so the PC stops downloading for a sandbox whose address the machine of ours takes over.
- [Setup.vue](Setup.vue) — the page that wires the flows together.
- [add/useAddSandbox.ts](add/useAddSandbox.ts) — the Add sandbox dialog's press, over the same flows.
- [SetupAccount.vue](SetupAccount.vue) — the masthead's account and its sign-out, the page being outside the shell's
  account menu; the page discards its draft row first, while the session can still delete it.
