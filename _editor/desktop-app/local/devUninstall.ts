import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { sleep } from "@intentic/base/async";
import type { UninstallFinish, UninstallInventory, UninstallProgress, UninstallStep } from "../src/desktopUninstall";

// "Uninstall Intentic…" stood in for on a dev server (devDesktop.ts), kept apart from the rest of it: what `ic uninstall
// --dry-run --json` answers, a run played step by step on `desktop://uninstall` as src-tauri/src/uninstall.rs sends it,
// and the app's last step. Which computer is chosen by `?uninstall=` on the dev address, kept for the tab's reloads:
// - `full` (the default): three sandboxes (one removed and recoverable), saved passwords, Intentic's engine, the machine
//   agent syncing two folders and in WSL; every step comes off.
// - `few`: one sandbox and nothing else of the reader's.
// - `passwords`: saved passwords and no sandbox.
// - `empty`: nothing of the reader's: no choice to make.
// - `partial`: as `full`, and two steps do not come off, each with the command that finishes it.
// - `hold`: as `full`, and the run stops on its third step, to be looked at.
// - `package`: as `full`, and the app's own package cannot be removed from here (a deb whose password prompt was closed).
// - `lookFailed`: ic cannot look.

type Case = `full` | `few` | `passwords` | `empty` | `partial` | `hold` | `package` | `lookFailed`;
const CASES: readonly Case[] = [`full`, `few`, `passwords`, `empty`, `partial`, `hold`, `package`, `lookFailed`];

// Read as this module loads, before the page rewrites its address (local/main.ts); a reload without it is `full`.
const KIND: Case = CASES.find((kind) => kind === new URL(window.location.href).searchParams.get(`uninstall`)) ?? `full`;

const FULL: UninstallInventory = {
    version: 1,
    os: `windows`,
    sandboxes: [
        { slug: `shop`, kind: `sandbox`, state: `running`, bytes: 4_100_000_000 },
        { slug: `thesis`, kind: `sandbox`, state: `stopped`, bytes: 17_900_000_000 },
        { slug: `ada-laptop-sandbox-2`, kind: `sandbox`, state: `removed`, bytes: null },
    ],
    deleteCount: 3,
    passwords: true,
    engine: { bytes: 18_000_000_000, holdsOthers: false },
    agent: { folders: 2, distros: [`Ubuntu`] },
    app: { version: `1.318.0` },
    cacheBytes: 1_400_000_000,
    stays: [`Docker Desktop`, `WSL`, `the files in your synced folders`],
    steps: {
        everything: [
            { step: `stop`, label: `Stop Intentic` },
            { step: `distros`, label: `Remove Intentic from WSL (Ubuntu)` },
            { step: `sandboxes`, label: `Delete 3 sandboxes` },
            { step: `agent`, label: `Remove the machine agent, folder sync and your saved passwords` },
            { step: `engine`, label: `Remove the intentic engine` },
            { step: `files`, label: `Delete Intentic's files and caches` },
            { step: `ic`, label: `Remove ic` },
        ],
        "keep-sandboxes": [
            { step: `sync`, label: `Stop syncing 2 folders` },
            { step: `files`, label: `Delete caches` },
        ],
    },
};

const inventoryOf = (kind: Case): UninstallInventory => {
    switch (kind) {
        case `few`:
            return {
                ...FULL,
                sandboxes: [FULL.sandboxes[0]!],
                deleteCount: 1,
                passwords: false,
                agent: { folders: 0, distros: [] },
                stays: [`Docker Desktop`, `WSL`],
                steps: {
                    everything: [
                        { step: `stop`, label: `Stop Intentic` },
                        { step: `sandboxes`, label: `Delete 1 sandbox` },
                        { step: `agent`, label: `Remove the machine agent` },
                        { step: `engine`, label: `Remove the intentic engine` },
                        { step: `files`, label: `Delete Intentic's files and caches` },
                        { step: `ic`, label: `Remove ic` },
                    ],
                    "keep-sandboxes": [{ step: `files`, label: `Delete caches` }],
                },
            };
        case `passwords`:
            return {
                ...FULL,
                sandboxes: [],
                deleteCount: 0,
                engine: null,
                agent: { folders: 0, distros: [] },
                stays: [],
                steps: {
                    everything: [
                        { step: `stop`, label: `Stop Intentic` },
                        { step: `agent`, label: `Remove the machine agent and your saved passwords` },
                        { step: `files`, label: `Delete Intentic's files and caches` },
                        { step: `ic`, label: `Remove ic` },
                    ],
                    "keep-sandboxes": [{ step: `files`, label: `Delete caches` }],
                },
            };
        case `empty`:
            return {
                ...FULL,
                sandboxes: [],
                deleteCount: 0,
                passwords: false,
                engine: null,
                agent: null,
                cacheBytes: 86_000_000,
                stays: [],
                steps: {
                    everything: [
                        { step: `files`, label: `Delete Intentic's files and caches` },
                        { step: `ic`, label: `Remove ic` },
                    ],
                },
            };
        default:
            return FULL;
    }
};

/** What each step says when it is done, as ic would. */
const DONE_DETAIL = new Map<string, string>([
    [`stop`, `Stopped the machine agent.`],
    [`sandboxes`, `Deleted shop, thesis and ada-laptop-sandbox-2.`],
    [`engine`, `Removed the intentic-engine WSL distro (18 GB).`],
    [`files`, `Freed 1.4 GB.`],
]);
/** What a step says while it runs. */
const RUNNING_DETAIL = new Map<string, string>([
    [`sandboxes`, `Deleting thesis (17.9 GB)…`],
    [`engine`, `Unregistering the intentic-engine distro…`],
]);

// allow(module-state): the stand-in's one uninstall, as uninstall.rs keeps its last
let last: UninstallProgress | null = null;

const told = async (progress: UninstallProgress): Promise<void> => {
    last = progress;
    await emit(`desktop://uninstall`, progress);
};

const play = async (kind: Case, choice: `everything` | `keep-sandboxes`): Promise<UninstallProgress> => {
    const plan = inventoryOf(kind).steps[choice] ?? [];
    let steps: UninstallStep[] = plan.map((planned) => ({ ...planned, state: `pending`, detail: null }));
    const at = (index: number, change: Partial<UninstallStep>): void => {
        steps = steps.map((step, position) => (position === index ? { ...step, ...change } : step));
    };
    await told({ choice: null, steps: [], outcome: null, log: null });
    await sleep(700);
    await told({ choice, steps, outcome: null, log: null });
    const failing = kind === `partial` ? new Set([`engine`, `ic`]) : new Set<string>();
    for (const [index, step] of plan.entries()) {
        at(index, { state: `running`, detail: RUNNING_DETAIL.get(step.step) ?? null });
        await told({ choice, steps, outcome: null, log: null });
        if (kind === `hold` && index === 2) {
            // Held here for a look, as a long deletion would be.
            return new Promise(() => undefined);
        }
        await sleep(step.step === `sandboxes` ? 2200 : 1100);
        if (failing.has(step.step)) {
            at(index, { state: `failed`, detail: `It is still in use.` });
        } else if (step.step === `distros` && choice === `everything` && kind === `few`) {
            at(index, { state: `skipped`, detail: null });
        } else {
            at(index, { state: `done`, detail: DONE_DETAIL.get(step.step) ?? null });
        }
        await told({ choice, steps, outcome: null, log: null });
    }
    const failed =
        kind === `partial`
            ? [
                  {
                      label: `Remove the intentic engine`,
                      problem: `WSL kept the intentic-engine distro open, so it could not be unregistered.`,
                      fix: `wsl --unregister intentic-engine`,
                  },
                  {
                      label: `Remove ic`,
                      problem: `C:\\Users\\ada\\.intentic\\ic\\bin\\ic.exe is in use by another program.`,
                      fix: `Remove-Item -Recurse -Force "$env:USERPROFILE\\.intentic\\ic"`,
                  },
              ]
            : [];
    const done: UninstallProgress = {
        choice,
        steps,
        outcome: { result: failed.length > 0 ? `partial` : `done`, stays: inventoryOf(kind).stays, failed, code: failed.length > 0 ? 1 : 0 },
        log: `C:\\Users\\ada\\AppData\\Local\\Temp\\intentic-uninstall\\desktop-uninstall-20261018-201500.log`,
    };
    await told(done);
    return done;
};

const choiceArg = (args: InvokeArgs | undefined): `everything` | `keep-sandboxes` =>
    args !== undefined && `choice` in args && args[`choice`] === `keep-sandboxes` ? `keep-sandboxes` : `everything`;

const lookAt = async (kind: Case): Promise<UninstallInventory> => {
    await sleep(900);
    if (kind === `lookFailed`) {
        throw new Error(`ic uninstall --dry-run did not answer within 180s`);
    }
    return inventoryOf(kind);
};

const finish = async (kind: Case, args: InvokeArgs | undefined): Promise<UninstallFinish> => {
    const leave = args !== undefined && `leavePackage` in args && args[`leavePackage`] === true;
    if (kind === `package` && !leave) {
        await sleep(1200);
        return { closing: false, command: `sudo apt-get remove -y intentic`, reason: `The password prompt was closed or refused.` };
    }
    console.warn(`[dev desktop] the app would close now, and remove itself`);
    return { closing: true, command: null, reason: null };
};

/** What an uninstall command answers. */
export type UninstallAnswer = Promise<UninstallInventory | UninstallProgress | UninstallFinish> | UninstallProgress | null;

/** The answer to an uninstall command, or undefined for any other. */
export const uninstallVerb = (command: string, args: InvokeArgs | undefined): UninstallAnswer | undefined => {
    const kind = KIND;
    switch (command) {
        case `uninstall_inventory`:
            return lookAt(kind);
        case `uninstall_state`:
            return last;
        case `uninstall_run`:
            return play(kind, choiceArg(args));
        case `uninstall_finish`:
            return finish(kind, args);
        default:
            return undefined;
    }
};
