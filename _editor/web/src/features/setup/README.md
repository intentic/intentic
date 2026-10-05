# setup

The `/setup` page: it makes the sandbox row a visit sets up, decides by itself where that sandbox runs, and opens its workspace once the sandbox answers.

- **What an arrival does by itself** is decided in one place, `arrivalFor` in `setupArrival.ts`: the desktop app hands
  the setup code to itself (`local`), a browser starts a machine of ours (`hosted`), and the picker (`choose`) survives
  only where the surface's own answer is unavailable or was asked for. An account that removed a sandbox it can still
  restore (the platform's trash, or a trash that could not be read) starts nothing by itself: the picker waits for a
  click, since the app once installed a new sandbox seconds after its reader removed the last one.
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

## Key files

- [setupArrival.ts](setupArrival.ts) — what an arrival does by itself, a project's included, and the folder's name in the sandbox.
- [../sandbox/client/sandboxName.ts](../sandbox/client/sandboxName.ts) — the name a new sandbox gets, numbered past the account's own; the desktop app's folder dialog names one the same way.
- [flow/useSetupArrival.ts](flow/useSetupArrival.ts) — reads the offers and the row, decides the arrival and takes it.
- [flow/machineLadder.ts](flow/machineLadder.ts) — the picker's rungs, and which of them a project may have.
- [flow/useHostedLane.ts](flow/useHostedLane.ts) — the machine of ours on the row: provision, wait, restart, hand back.
- [hostedProject.ts](hostedProject.ts) — the hand-over of a hosted project's folder to the desktop app.
- [Setup.vue](Setup.vue) — the page that wires the flows together.
- [SetupAccount.vue](SetupAccount.vue) — the masthead's account and its sign-out, the page being outside the shell's
  account menu; the page discards its draft row first, while the session can still delete it.
