import type { FolderSetup } from "../desktop";
import { folderSetupOf, folderSetupRunningBesides } from "./folderSetups";
import { folderSetupFor, needsOf, projectPathOf, setupStateOf } from "./projectBuild";

// A folder on its way to its own sandbox, read off the app's records into what its window's page and button draw: every
// state a record can be in, the folder found by the path its window is told, and where "Open sandbox" goes.

const RECORD: FolderSetup = {
    path: `C:\\Users\\ada\\code\\shop`,
    name: `shop`,
    state: `creating`,
    phase: `pulling-image`,
    step: `using the sandbox image already here`,
    percent: 42,
    left: 120,
    sandboxId: `cmshop0001`,
    slug: `sandbox-2c8eb2c5b3a5`,
    hostname: `sandbox-2c8eb2c5b3a5.sbx.intentic.dev`,
    sandboxName: `shop`,
    made: false,
    attempt: 1,
    askedAt: 1_790_000_000_000,
    startedAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_500,
};

it(`draws nothing for a folder not on its way`, () => {
    expect(folderSetupFor(undefined)).toBeUndefined();
});

it(`says how far it is being made, and whether it has a log`, () => {
    expect(folderSetupFor(RECORD)).toEqual({
        state: `creating`,
        phase: `pulling-image`,
        step: `using the sandbox image already here`,
        percent: 42,
        left: 120,
        name: `shop`,
        status: undefined,
        heldBy: [],
        made: false,
        hasLog: false,
        startedAt: 1_790_000_000_000,
    });
    expect(folderSetupFor({ ...RECORD, logPath: `/home/ada/.intentic/logs/desktop-folder-setup.log` })?.hasLog).toBe(true);
});

// Fields a state does not have are said as undefined, never carried over from the record.
it(`reads every state the app can be in`, () => {
    expect(setupStateOf({ state: `creating`, percent: 0 })).toEqual({ state: `creating`, phase: undefined, step: undefined, percent: 0, left: undefined });
    expect(setupStateOf({ state: `queued` })).toEqual({ state: `queued`, behind: undefined });
    expect(setupStateOf({ state: `queued`, behind: `notes` })).toEqual({ state: `queued`, behind: `notes` });
    expect(setupStateOf({ state: `needsDocker`, reason: `notRunning` })).toEqual({ state: `needsDocker`, reason: `notRunning` });
    expect(setupStateOf({ state: `waiting`, for: `restart` })).toEqual({ state: `waiting`, for: `restart`, needs: [] });
    expect(setupStateOf({ state: `failed`, reason: `docker refused` })).toEqual({ state: `failed`, reason: `docker refused` });
    for (const state of [`signedOut`, `signedIn`, `copying`, `ready`, `interrupted`] as const) {
        expect(setupStateOf({ state })).toEqual({ state });
    }
});

it(`names what a setup stopped on a question said this computer needs, by each requirement's own title`, () => {
    const asked = [
        { id: `wsl-features`, title: `Turn on WSL`, problem: `x`, remedy: `y`, action: `fixElevated` },
        { title: `no id` },
    ];
    expect(needsOf(asked)).toEqual([`Turn on WSL`]);
    expect(setupStateOf({ state: `waiting`, for: `consent`, requirements: asked })).toEqual({ state: `waiting`, for: `consent`, needs: [`Turn on WSL`] });
});

it(`finds the window's own folder by the path it is told, and no other`, () => {
    const records = [RECORD, { ...RECORD, path: `C:\\Users\\ada\\notes`, name: `notes`, state: `failed` as const, reason: `no` }];
    expect(folderSetupOf(records, `C:\\Users\\ada\\notes`)?.name).toBe(`notes`);
    expect(folderSetupOf(records, `C:\\Users\\ada\\code`)).toBeUndefined();
    expect(folderSetupOf(records, undefined)).toBeUndefined();
    expect(folderSetupOf(undefined, `C:\\Users\\ada\\code\\shop`)).toBeUndefined();
});

// The window on a folder being made has that setup's own tile: Devices spins only for another folder's.
it(`spins Devices for a sandbox being made for any folder but the window's own`, () => {
    const notes = { ...RECORD, path: `C:\\Users\\ada\\notes`, name: `notes`, state: `failed` as const, reason: `no` };
    expect(folderSetupRunningBesides([RECORD, notes], RECORD.path)).toBe(false);
    expect(folderSetupRunningBesides([RECORD, notes], notes.path)).toBe(true);
    expect(folderSetupRunningBesides([RECORD], undefined)).toBe(true);
    expect(folderSetupRunningBesides(undefined, undefined)).toBe(false);
});

it(`opens a folder's sandbox on the folder, and nowhere without a sandbox to name`, () => {
    expect(projectPathOf({ sandboxId: `cmshop0001`, project: `shop` })).toBe(`/?sandbox=cmshop0001&project=shop`);
    expect(projectPathOf({ sandboxId: `a b`, project: `x&y` })).toBe(`/?sandbox=a+b&project=x%26y`);
    expect(projectPathOf({ sandboxId: undefined, project: `x` })).toBeUndefined();
});
