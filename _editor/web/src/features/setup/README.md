# setup

The `/setup` page: it makes the sandbox row a visit sets up, decides by itself where that sandbox runs, and opens its workspace once the sandbox answers.

- **What an arrival does by itself** is decided in one place, `arrivalFor` in `setupArrival.ts`: the desktop app hands
  the setup code to itself (`local`), a browser starts a machine of ours (`hosted`), and the picker (`choose`) survives
  only where the surface's own answer is unavailable or was asked for. An account that removed a sandbox it can still
  restore (the platform's trash, or a trash that could not be read) starts nothing by itself: the picker waits for a
  click, since the app once installed a new sandbox seconds after its reader removed the last one.
  `flow/useSetupArrival.ts` takes the answer; the other flows are the lanes it takes it on.
- **A project.** The desktop app's "Work on this with an agent" parks a folder and opens `/setup?project=<folder name>`,
  and `setupProjectOf` derives the folder's name in the sandbox (`/work/<dirName>`) once. Where the platform's machines
  can hold a project (`hostedOffer.projects`), a machine of ours is the project's rung: started for a row this visit
  made, preselected on one it found, and asked for with the folder's name (the platform's `hostedProvision` with
  `project`, `flow/useHostedLane.ts`). "My own computer" stays one pick away, and is where the folder goes when no
  machine can be started, as it always went on a platform that says nothing about projects: the app is handed the
  setup code with `project=` and runs the sandbox on this computer.
- **The folder reaches a machine of ours through the app.** Once the machine answers (`flow/useRegistryWatch.ts`),
  `hostedProject.ts` mints a sync pairing on it the way the Desktop sync card does and opens
  `intentic://sync?url&pair&name&project&sandbox` inside the app, which copies the folder it parked into
  `/work/<dirName>`; only then does the workspace open. A hand-over that fails keeps the page with a notice, and the next
  registry reading tries again. Outside the app nothing is handed over.
- **What the page says** about a project, on either machine: the folder is copied into the sandbox, agents work on the
  copy, and their changes come back when the owner presses "Bring back changes" in the folder's window.

## Key files

- [setupArrival.ts](setupArrival.ts) — what an arrival does by itself, a project's included, and the folder's name in the sandbox.
- [flow/useSetupArrival.ts](flow/useSetupArrival.ts) — reads the offers and the row, decides the arrival and takes it.
- [flow/machineLadder.ts](flow/machineLadder.ts) — the picker's rungs, and which of them a project may have.
- [flow/useHostedLane.ts](flow/useHostedLane.ts) — the machine of ours on the row: provision, wait, restart, hand back.
- [hostedProject.ts](hostedProject.ts) — the hand-over of a hosted project's folder to the desktop app.
- [Setup.vue](Setup.vue) — the page that wires the flows together.
