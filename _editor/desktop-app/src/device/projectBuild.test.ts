import type { MachineSandbox } from "../desktop";
import { folderOf, machineOf, machineStateOf, projectPathOf } from "./projectBuild";

// This computer's sandbox and a folder on its way into it, read off the app's record into what a window's card and
// button draw: every state the record can be in, the folder found by the path its window is told, and where
// "Open sandbox" goes.

const RECORD: MachineSandbox = {
    state: `creating`,
    phase: `pulling-image`,
    step: `using the sandbox image already here`,
    percent: 42,
    sandboxId: `cmmachine0001`,
    slug: `sandbox-2c8eb2c5b3a5`,
    hostname: `sandbox-2c8eb2c5b3a5.sbx.intentic.dev`,
    name: `ada-laptop sandbox`,
    made: false,
    attempt: 1,
    updatedAt: 1_790_000_000,
    consented: false,
    resumeOnLaunch: false,
    requirements: [],
    folders: [
        { path: `C:\\Users\\ada\\code\\shop`, name: `shop`, state: `queued` },
        { path: `C:\\Users\\ada\\code\\api`, name: `api`, state: `copying`, status: `staging-beta` },
        { path: `C:\\Users\\ada\\notes`, name: `notes`, state: `failed`, reason: `That folder is already attached.` },
    ],
};

it(`draws nothing before the app has said`, () => {
    expect(machineOf(undefined)).toBeUndefined();
});

it(`says how far it is being made, how many folders wait for it, and whether it has a log`, () => {
    expect(machineOf(RECORD)).toEqual({
        state: `creating`,
        phase: `pulling-image`,
        step: `using the sandbox image already here`,
        percent: 42,
        name: `ada-laptop sandbox`,
        waiting: 1,
        hasLog: false,
    });
    expect(machineOf({ ...RECORD, logPath: `/home/ada/.intentic/logs/desktop-machine-setup.log` })?.hasLog).toBe(true);
});

// Fields a state does not have are said as undefined, never carried over from the record.
it(`reads every state the app can be in`, () => {
    expect(machineStateOf({ state: `creating`, percent: 0 })).toEqual({ state: `creating`, phase: undefined, step: undefined, percent: 0 });
    expect(machineStateOf({ state: `needsDocker`, reason: `notRunning` })).toEqual({ state: `needsDocker`, reason: `notRunning` });
    expect(machineStateOf({ state: `waiting`, for: `restart` })).toEqual({ state: `waiting`, for: `restart` });
    expect(machineStateOf({ state: `failed`, reason: `docker refused` })).toEqual({ state: `failed`, reason: `docker refused` });
    for (const state of [`signedOut`, `ready`, `stopped`, `interrupted`, `gone`] as const) {
        expect(machineStateOf({ state })).toEqual({ state });
    }
});

it(`finds the window's own folder by the path it is told, and no other`, () => {
    expect(folderOf(RECORD, `C:\\Users\\ada\\code\\api`)).toEqual({ name: `api`, state: `copying`, reason: undefined, status: `staging-beta` });
    expect(folderOf(RECORD, `C:\\Users\\ada\\notes`)).toEqual({ name: `notes`, state: `failed`, reason: `That folder is already attached.`, status: undefined });
    expect(folderOf(RECORD, `C:\\Users\\ada\\code`)).toBeUndefined();
    expect(folderOf(RECORD, undefined)).toBeUndefined();
    expect(folderOf(undefined, `C:\\Users\\ada\\code\\api`)).toBeUndefined();
});

it(`opens a folder's sandbox on the folder, and nowhere without a sandbox to name`, () => {
    expect(projectPathOf({ sandboxId: `cmmachine0001`, project: `shop` })).toBe(`/?sandbox=cmmachine0001&project=shop`);
    expect(projectPathOf({ sandboxId: `a b`, project: `x&y` })).toBe(`/?sandbox=a+b&project=x%26y`);
    expect(projectPathOf({ sandboxId: undefined, project: `x` })).toBeUndefined();
});
