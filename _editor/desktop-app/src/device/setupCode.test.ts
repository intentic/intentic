import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { FreshCode, ResumableSetup, RunEvent, SetupArgs } from "../desktop";

// A setup whose code ran out is carried on, not left on a dead code: a setup resumed after restarts on a code older than
// 20 minutes asks the app for a fresh one before it runs, and a run the platform refused at the claim runs again on a
// fresh one; only when none can be had does the card say the code ran out. The app is Tauri's own IPC mock.

// The kit's device readout (reached through ./machine) asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

const { record } = await import("./runs");
const load = () => freshImport<typeof import("./setup")>("./setup", import.meta.url);

const REFUSED = `error: the setup code is invalid or expired — refresh the platform's setup page and copy a fresh command.`;

let calls: { command: string; args: Record<string, unknown> }[] = [];
let parked: ResumableSetup | null = null;
let handedOver: SetupArgs | null = null;
// What the app answers for a fresh code, given the setup it was asked for.
let fresh: (args: SetupArgs) => FreshCode = (args) => ({ kind: `code`, args: { ...args, code: `fresh`, mintedAt: 2 } });
// What a run on a code ends with on stderr, for the codes whose run fails: the claim's refusal, or anything else.
let failures: Record<string, string> = {};

// What the app's run of the script says, as the window hears it (useDevice.ts): the setup's markers taken, the rest kept.
let hear: (event: RunEvent) => void = () => undefined;

const codesRun = (): string[] => calls.filter((call) => call.command === `setup_run`).map((call) => (call.args[`args`] as SetupArgs).code);
const asked = (command: string): number => calls.filter((call) => call.command === command).length;

beforeEach(() => {
    calls = [];
    parked = null;
    handedOver = null;
    fresh = (args) => ({ kind: `code`, args: { ...args, code: `fresh`, mintedAt: 2 } });
    failures = {};
    mockIPC((command, args) => {
        calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
        switch (command) {
            case `resumable_setup`:
                return parked;
            case `take_pending_setup`:
                return handedOver;
            case `setup_fresh_code`:
                return fresh((args as { args: SetupArgs }).args);
            case `setup_run`: {
                const said = failures[(args as { args: SetupArgs }).args.code];
                if (said === undefined) {
                    return null;
                }
                hear({ kind: `line`, run: `setup`, stream: `stdout`, text: `intentic: [claiming-code] redeeming the setup code...` });
                hear({ kind: `line`, run: `setup`, stream: `stderr`, text: said });
                hear({ kind: `exit`, run: `setup`, code: 1, ok: false });
                throw new Error(`connect.ps1 exited with status 1`);
            }
            default:
                return null;
        }
    });
});
afterEach(() => clearMocks());

const started = async () => {
    const setup = await load();
    hear = (event) => {
        if (!setup.takeSetupEvent(event)) {
            record(event);
        }
    };
    return setup;
};

const parkedFor = (codeAgeSeconds: number): ResumableSetup => ({
    args: { code: `old`, sandboxId: `cmsandbox0001`, name: `work`, mintedAt: 1 },
    agedSeconds: 60,
    codeAgeSeconds,
    how: `restart`,
});

describe(`a setup resumed after a restart`, () => {
    it(`runs on a fresh code when its own is older than 20 minutes`, async () => {
        parked = parkedFor(21 * 60);
        const setup = await started();
        await setup.loadResumable();
        expect(codesRun()).toEqual([`fresh`]);
        // Agreed to before the restart: the resumed run installs, as the run that asked for the restart would have.
        expect(calls.find((call) => call.command === `setup_run`)?.args[`install`]).toBe(true);
        expect(setup.expired.value).toBe(false);
    });

    it(`runs on its own code while that one is young, and asks for nothing`, async () => {
        parked = parkedFor(5 * 60);
        const setup = await started();
        await setup.loadResumable();
        expect(asked(`setup_fresh_code`)).toBe(0);
        expect(codesRun()).toEqual([`old`]);
    });

    it(`runs on its own code when no fresh one can be had and it still has minutes left`, async () => {
        parked = parkedFor(22 * 60);
        fresh = () => ({ kind: `refused`, reason: `The platform couldn't make the sandbox: not found` });
        const setup = await started();
        await setup.loadResumable();
        expect(codesRun()).toEqual([`old`]);
        expect(setup.expired.value).toBe(false);
    });

    it(`says the code ran out, and forgets the setup, only when no fresh one can be had past its time`, async () => {
        parked = parkedFor(40 * 60);
        fresh = () => ({ kind: `signedOut` });
        const setup = await started();
        await setup.loadResumable();
        expect(codesRun()).toEqual([]);
        expect(asked(`forget_resumable_setup`)).toBe(1);
        expect(setup.expired.value).toBe(true);
    });

    it(`does not resume a setup parked hours ago, however fresh a code could be`, async () => {
        // A restart that was cancelled the evening before: whatever the reader did since is not to be overruled.
        parked = { ...parkedFor(7 * 60 * 60), agedSeconds: 7 * 60 * 60 };
        const setup = await started();
        await setup.loadResumable();
        expect(asked(`setup_fresh_code`)).toBe(0);
        expect(codesRun()).toEqual([]);
        expect(asked(`forget_resumable_setup`)).toBe(1);
        expect(setup.expired.value).toBe(true);
    });
});

describe(`a run the platform refused at the claim`, () => {
    it(`runs again on a fresh code for the same sandbox, not on the dead one`, async () => {
        handedOver = { code: `dead`, sandboxId: `cmsandbox0001`, mintedAt: 1 };
        failures = { dead: REFUSED };
        const setup = await started();
        await setup.loadPending();
        expect(codesRun()).toEqual([`dead`, `fresh`]);
        const asking = calls.find((call) => call.command === `setup_fresh_code`)?.args[`args`] as SetupArgs | undefined;
        expect(asking?.sandboxId).toBe(`cmsandbox0001`);
        expect(setup.pending.value).toBeUndefined();
        expect(setup.expired.value).toBe(false);
    });

    it(`says the code ran out, with the way to a fresh one, when none can be had here`, async () => {
        handedOver = { code: `dead`, sandboxId: `cmsandbox0001` };
        failures = { dead: REFUSED };
        fresh = () => ({ kind: `signedOut` });
        const setup = await started();
        await setup.loadPending();
        expect(codesRun()).toEqual([`dead`]);
        expect(setup.expired.value).toBe(true);
    });

    it(`mints once: a fresh code refused in turn is a failure to show, not a loop`, async () => {
        handedOver = { code: `dead`, sandboxId: `cmsandbox0001` };
        failures = { dead: REFUSED, fresh: REFUSED };
        const setup = await started();
        await setup.loadPending();
        expect(codesRun()).toEqual([`dead`, `fresh`]);
        expect(asked(`setup_fresh_code`)).toBe(1);
        expect(setup.expired.value).toBe(false);
        expect(setup.setupError.value).toEqual(expect.any(String));
    });

    it(`leaves any other failure to the card's Try again, on the same code`, async () => {
        handedOver = { code: `live`, sandboxId: `cmsandbox0001` };
        failures = { live: `error: Docker Desktop is not running.` };
        const setup = await started();
        await setup.loadPending();
        expect(asked(`setup_fresh_code`)).toBe(0);
        expect(codesRun()).toEqual([`live`]);
        expect(setup.expired.value).toBe(false);
    });
});
