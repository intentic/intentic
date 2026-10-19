import type { LocalCheckRow, LocalFirstTask, LocalPcCheck } from "@intentic/web/local-host";
import { checksPassed, minutesLeft, movesSandboxes, offersWork, pcCardPhase, type PcCardInput, pcSteps, taskStart, unmetRows } from "./pcCard";

// What This computer's card for this PC says, from what the app last said about the PC, its setup, this computer's own
// sandbox and the first task.

const row = (id: string, state: LocalCheckRow[`state`]): LocalCheckRow => ({ id, state, label: id, detail: undefined, admin: false });

const check = (state: LocalPcCheck[`state`], rows: readonly LocalCheckRow[] = []): LocalPcCheck => ({
    state,
    rows,
    machine: `Windows 11, 16 GB memory`,
    restart: true,
    admin: true,
    downloadBytes: 3_000_000_000,
    minutes: 20,
    engine: `intentic`,
});

const task = (state: LocalFirstTask[`state`]): LocalFirstTask => ({ folder: `C:\\code\\shop`, text: `Fix the tests`, queuedAt: 1, state, reason: undefined });

// A first launch on Windows: the check says this PC needs its setup, nobody is signed in, nothing has been pressed.
const FIRST_LAUNCH: PcCardInput = { os: `windows`, check: check(`needsSetup`), setup: { state: `idle` }, machine: `signedOut`, firstTask: undefined };

describe(`the card for this PC's own setup`, () => {
    it(`says nothing off Windows, whatever the app says of the PC`, () => {
        expect(pcCardPhase({ ...FIRST_LAUNCH, os: `linux` })).toBe(`hidden`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, os: `macos`, setup: { state: `running`, step: undefined, percent: 10 } })).toBe(`hidden`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, os: undefined })).toBe(`hidden`);
    });

    it(`offers the setup the check says this PC needs`, () => {
        expect(pcCardPhase(FIRST_LAUNCH)).toBe(`needsSetup`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, machine: `waiting` })).toBe(`needsSetup`);
    });

    it(`says the setup's own state ahead of whatever the check made before it still says`, () => {
        const running = { state: `running`, step: `Turning on WSL`, percent: 40 } as const;
        expect(pcCardPhase({ ...FIRST_LAUNCH, setup: running })).toBe(`settingUp`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`cantRun`), setup: running })).toBe(`settingUp`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: undefined, setup: { state: `waiting`, for: `restart` } })).toBe(`restart`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, setup: { state: `waiting`, for: `admin` } })).toBe(`admin`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`ready`), setup: { state: `waiting`, for: `signOut` } })).toBe(`signOut`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`unknown`), setup: { state: `failed`, reason: `boom` } })).toBe(`setupFailed`);
    });

    it(`waits for the check, unless this computer's sandbox shows the PC was ready for it`, () => {
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: undefined })).toBe(`checking`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`checking`), machine: undefined })).toBe(`checking`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`checking`), machine: `waiting` })).toBe(`checking`);
        for (const machine of [`ready`, `creating`, `interrupted`, `stopped`] as const) {
            expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`checking`), machine })).toBe(`hidden`);
        }
    });

    it(`says when the check could not read this PC, and when this PC cannot run agents`, () => {
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`unknown`) })).toBe(`checkUnknown`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`cantRun`), machine: `ready` })).toBe(`cantRun`);
    });

    it(`stays for the sign-in on a ready PC, and goes once someone is signed in`, () => {
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`ready`) })).toBe(`signIn`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`ready`), machine: `creating` })).toBe(`hidden`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`ready`), machine: `ready`, firstTask: task(`queued`) })).toBe(`hidden`);
        // Nothing heard of this computer's sandbox yet is not "signed out".
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`ready`), machine: undefined })).toBe(`hidden`);
    });

    it(`takes a finished setup for a ready PC, whatever the check made before it said`, () => {
        expect(pcCardPhase({ ...FIRST_LAUNCH, setup: { state: `ready` } })).toBe(`signIn`);
        expect(pcCardPhase({ ...FIRST_LAUNCH, setup: { state: `ready` }, machine: `creating` })).toBe(`hidden`);
    });

    it(`comes back for a first task that failed to start once it could`, () => {
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`ready`), machine: `ready`, firstTask: task(`failed`) })).toBe(`firstTaskFailed`);
        // Signed out, the sign-in is what the card is for; the box under it shows the failure too.
        expect(pcCardPhase({ ...FIRST_LAUNCH, check: check(`ready`), firstTask: task(`failed`) })).toBe(`signIn`);
    });

    it(`carries the sign-in, the download and the first task only where there is work for the reader`, () => {
        const phases = [
            `hidden`,
            `checking`,
            `checkUnknown`,
            `needsSetup`,
            `settingUp`,
            `restart`,
            `admin`,
            `signOut`,
            `setupFailed`,
            `cantRun`,
            `signIn`,
            `firstTaskFailed`,
        ] as const;
        expect(phases.filter(offersWork)).toEqual([`needsSetup`, `settingUp`, `restart`, `admin`, `signOut`, `setupFailed`, `signIn`, `firstTaskFailed`]);
    });
});

describe(`what the card lists and counts`, () => {
    const rows = [row(`memory`, `met`), row(`wsl`, `ours`), row(`virtualization`, `met`), row(`disk-space`, `yours`), row(`slat`, `blocked`)];

    it(`lists only what is still to do, and counts what is met in one line`, () => {
        expect(unmetRows(check(`needsSetup`, rows)).map((each) => each.id)).toEqual([`wsl`, `disk-space`, `slat`]);
        expect(checksPassed(check(`needsSetup`, rows))).toEqual({ met: 2, total: 5 });
        expect(checksPassed(check(`needsSetup`))).toBeUndefined();
        expect(unmetRows(undefined)).toEqual([]);
    });

    it(`gives the minutes a running setup has left, rounded up, and none once it is at its end`, () => {
        expect(minutesLeft(check(`needsSetup`), { state: `running`, step: undefined, percent: 62 })).toBe(8);
        expect(minutesLeft(check(`needsSetup`), { state: `running`, step: undefined, percent: 100 })).toBeUndefined();
        expect(minutesLeft({ ...check(`needsSetup`), minutes: 0 }, { state: `running`, step: undefined, percent: 10 })).toBeUndefined();
        expect(minutesLeft(check(`needsSetup`), { state: `idle` })).toBeUndefined();
    });

    it(`says when a first task starts: once the PC is ready, once someone signs in, or both, or now`, () => {
        expect(taskStart(`needsSetup`, true)).toBe(`pcAndSignIn`);
        expect(taskStart(`settingUp`, false)).toBe(`pc`);
        expect(taskStart(`signIn`, true)).toBe(`signIn`);
        expect(taskStart(`firstTaskFailed`, false)).toBe(`now`);
    });
});

describe(`the card's three steps: this PC, the sign-in, the first task`, () => {
    it(`makes this PC's setup the next press on a first launch, the sign-in a press beside it, and closes the first task`, () => {
        expect(pcSteps(`needsSetup`, true, `none`)).toEqual({ pc: `current`, account: `todo`, task: `locked` });
    });

    it(`makes the sign-in the next press once this PC is ready, or while its setup runs by itself`, () => {
        expect(pcSteps(`signIn`, true, `none`)).toEqual({ pc: `done`, account: `current`, task: `locked` });
        expect(pcSteps(`settingUp`, true, `none`)).toEqual({ pc: `running`, account: `current`, task: `locked` });
    });

    it(`keeps the sign-in beside a setup that waits on the reader or stopped`, () => {
        for (const phase of [`restart`, `admin`, `signOut`] as const) {
            expect(pcSteps(phase, true, `none`)).toEqual({ pc: `attention`, account: `todo`, task: `locked` });
        }
        expect(pcSteps(`setupFailed`, true, `none`)).toEqual({ pc: `failed`, account: `todo`, task: `locked` });
    });

    it(`opens the first task once someone is signed in, as the next press while the setup runs`, () => {
        expect(pcSteps(`needsSetup`, false, `none`)).toEqual({ pc: `current`, account: `done`, task: `todo` });
        expect(pcSteps(`settingUp`, false, `none`)).toEqual({ pc: `running`, account: `done`, task: `current` });
        expect(pcSteps(`restart`, false, `none`)).toEqual({ pc: `attention`, account: `done`, task: `todo` });
    });

    it(`shows a task begun, kept, started or failed whoever is signed in`, () => {
        expect(pcSteps(`needsSetup`, true, `draft`).task).toBe(`current`);
        expect(pcSteps(`needsSetup`, true, `kept`).task).toBe(`done`);
        expect(pcSteps(`signIn`, true, `sent`).task).toBe(`done`);
        expect(pcSteps(`signIn`, true, `failed`).task).toBe(`failed`);
        expect(pcSteps(`firstTaskFailed`, false, `failed`)).toEqual({ pc: `done`, account: `done`, task: `failed` });
    });
});

describe(`the sandbox move a setup includes`, () => {
    it(`is announced only while the check still lists the engine move`, () => {
        expect(movesSandboxes(check(`needsSetup`, [row(`engine`, `ours`), row(`engine-move`, `ours`)]))).toBe(true);
        expect(movesSandboxes(check(`needsSetup`, [row(`engine`, `ours`), row(`engine-move`, `met`)]))).toBe(false);
        expect(movesSandboxes(check(`needsSetup`, [row(`engine`, `ours`)]))).toBe(false);
        expect(movesSandboxes(undefined)).toBe(false);
    });
});
