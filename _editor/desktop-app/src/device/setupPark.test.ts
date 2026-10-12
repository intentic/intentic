import "@intentic/testing/dom";
import { advanceTimersByTimeAsync, freshImport, waitFor } from "@intentic/testing/bun";
import type { LocalPcCheck } from "@intentic/web/local-host";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { nextTick, ref, watch } from "vue";
import type { OnboardingCheck, OnboardingSetup, RunEvent, SetupArgs, SetupReport } from "../desktop";

// A setup handed over while this Windows PC still needs its own setup (Docker/WSL, onboarding) used to do nothing at
// all, and the workspace page waited on a run that never started (2026-10-12). Now it is parked, said to be parked, offers
// this PC's setup, and carries on by itself once the PC is ready; and every report it sends says when it was sent, again
// and again while it waits. The app is Tauri's own IPC mock; onboarding's reading of the PC is a stand-in the test moves.

// The kit's device readout (reached through ./machine) asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

// Onboarding's reading of this PC, as onboarding/pc.ts hands it out: its check, this PC's setup, and its presses. One per
// test, so a setup module an earlier test loaded follows refs nothing moves any more.
const standIn = () => ({
    check: ref<LocalPcCheck | undefined>(undefined),
    setup: ref<OnboardingSetup>({ state: `idle` }),
    setUp: jest.fn(async (_from?: string) => undefined),
    recheck: jest.fn(async () => undefined),
    restart: jest.fn(async () => undefined),
});
let pc = standIn();
// `currentPcCheck`: the check once it has answered, never before.
const isAnswered = (now: LocalPcCheck | undefined): now is LocalPcCheck => now !== undefined && now.state !== `checking`;
const answered = (): Promise<OnboardingCheck> => {
    const now = pc.check.value;
    if (isAnswered(now)) {
        return Promise.resolve({ ...now, machine: undefined });
    }
    return new Promise((resolve) => {
        const stop = watch(
            () => pc.check.value,
            (later) => {
                if (isAnswered(later)) {
                    stop();
                    resolve({ ...later, machine: undefined });
                }
            },
        );
    });
};
jest.mock(`../onboarding/pc`, () => ({
    pcParts: () => pc,
    currentPcCheck: () => answered(),
    followPcSetup: () => pc.setup,
    setUpThisPc: (from?: string) => pc.setUp(from),
}));
const sent: { event: string; properties: Record<string, unknown> | undefined }[] = [];
jest.mock(`../analytics`, () => ({
    track: (event: string, properties?: Record<string, unknown>) => sent.push({ event, properties }),
    trackBeforeExit: async (event: string, properties?: Record<string, unknown>) => {
        sent.push({ event, properties });
    },
    initAnalytics: () => undefined,
    setEngine: () => undefined,
}));

const { record } = await import("./runs");
const machine = await import("./machine");
const load = () => freshImport<typeof import("./setup")>("./setup", import.meta.url);

const check = (state: LocalPcCheck[`state`]): LocalPcCheck => ({
    state,
    rows: [],
    machine: undefined,
    restart: true,
    admin: true,
    downloadBytes: 0,
    minutes: 12,
    engine: `intentic`,
});
let calls: { command: string; args: Record<string, unknown> }[] = [];
let os = `windows`;
let handedOver: SetupArgs | null = null;
let dockerAnswer = false;
// A run that ends when the test says so, for what is said while one runs; or that the app kills, as `run_stop` does.
let finishRun: (() => void) | undefined;
let killRun: (() => void) | undefined;
let hold = false;
let held = false;
let hear: (event: RunEvent) => void = () => undefined;

// SAFETY: `setup_run`'s arguments are the ones setup.ts invoked it with (desktop.ts `setupRun`), recorded as given.
const codesRun = (): string[] => calls.filter((call) => call.command === `setup_run`).map((call) => (call.args[`args`] as SetupArgs).code);
const asked = (command: string): number => calls.filter((call) => call.command === command).length;
// SAFETY: `setup_progress` is only ever invoked with a report (desktop.ts `setupProgress`), recorded as given.
const reports = (): SetupReport[] => calls.filter((call) => call.command === `setup_progress`).map((call) => call.args[`report`] as SetupReport);
const lastReport = (): SetupReport | undefined => reports().at(-1);

let loaded: Awaited<ReturnType<typeof load>> | undefined;
const started = async () => {
    const setup = await load();
    loaded = setup;
    hear = (event) => {
        if (!setup.takeSetupEvent(event)) {
            record(event);
        }
    };
    return setup;
};

beforeEach(() => {
    calls = [];
    sent.length = 0;
    os = `windows`;
    handedOver = { code: `live`, sandboxId: `cmsandbox0001`, name: `work` };
    dockerAnswer = false;
    hold = false;
    held = false;
    finishRun = undefined;
    killRun = undefined;
    machine.dockerReady.value = undefined;
    pc = standIn();
    pc.check.value = check(`needsSetup`);
    mockIPC((command, args) => {
        // SAFETY: every command here is invoked with an object of named arguments, or with none.
        calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
        switch (command) {
            case `desktop_info`:
                return { os, version: `1.0.0`, appUrl: ``, platformUrl: ``, installId: `install`, engineLimitSeconds: 300, fixLimitSeconds: 600 };
            case `take_pending_setup`:
                return handedOver;
            case `docker_ready`:
                return dockerAnswer;
            case `setup_run`:
                if (!hold) {
                    return null;
                }
                held = true;
                return new Promise<null>((resolve, reject) => {
                    finishRun = () => resolve(null);
                    killRun = () => reject(new Error(`the setup exited without a code`));
                });
            // The app ends the run's whole tree: its exit is heard, and `setup_run` answers with the failure it ended in.
            case `run_stop`:
                hear({ kind: `exit`, run: `setup`, code: null, ok: false });
                killRun?.();
                return null;
            default:
                return null;
        }
    });
});
afterEach(() => {
    // A setup left waiting keeps its heartbeat going: given up here, so none outlives its test.
    loaded?.closeSetup();
    loaded = undefined;
    clearMocks();
});

describe(`a setup handed over to a Windows PC that still needs its own setup`, () => {
    it(`is parked, said to be parked to the page, and runs by itself once this PC's own setup is done`, async () => {
        const setup = await started();
        await setup.loadPending();
        expect(codesRun()).toEqual([]);
        expect(setup.pcParked.value).toBe(true);
        // Saved as a restart saves one: this PC's setup may well ask for a restart.
        expect(asked(`park_setup_for_pc`)).toBe(1);
        await nextTick();
        expect(lastReport()).toMatchObject({ state: `waiting`, waitingFor: `pcSetup`, name: `work`, at: expect.any(Number) });
        // A check made before Docker was installed by hand would still say it is needed: asked again, and Docker too.
        expect(pc.recheck).toHaveBeenCalledTimes(1);
        expect(asked(`docker_ready`)).toBe(1);
        expect(sent.find((said) => said.event === `desktop_install_pc_setup`)?.properties).toMatchObject({ action: `parked`, gate: `needsSetup` });

        // This PC's setup runs, and the setup handed over waits through it; then it finishes, and nobody presses anything.
        pc.setup.value = { state: `running`, percent: 40 };
        await nextTick();
        expect(setup.pcSetup.value).toMatchObject({ state: `running`, percent: 40 });
        expect(codesRun()).toEqual([]);
        pc.setup.value = { state: `ready` };
        await waitFor(() => expect(codesRun()).toEqual([`live`]));
        expect(setup.pcParked.value).toBe(false);
        expect(sent.some((said) => said.event === `desktop_install_pc_setup` && said.properties?.[`action`] === `continued`)).toBe(true);
    });

    it(`runs by itself once the check, asked again, says this PC is ready`, async () => {
        const setup = await started();
        await setup.loadPending();
        await setup.recheckThisPc();
        expect(pc.recheck).toHaveBeenCalledTimes(2);
        pc.check.value = check(`ready`);
        await waitFor(() => expect(codesRun()).toEqual([`live`]));
    });

    it(`waits for a check that has not answered rather than running, then follows what it says`, async () => {
        pc.check.value = check(`checking`);
        const setup = await started();
        await setup.loadPending();
        expect(codesRun()).toEqual([]);
        expect(setup.pcParked.value).toBe(true);
        expect(sent.find((said) => said.event === `desktop_install_pc_setup`)?.properties).toMatchObject({ gate: `checking` });
        // Nothing to check again yet: the first check is still running.
        expect(pc.recheck).not.toHaveBeenCalled();
        pc.check.value = check(`needsSetup`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(codesRun()).toEqual([]);
        expect(setup.pcParked.value).toBe(true);
        pc.check.value = check(`ready`);
        await waitFor(() => expect(codesRun()).toEqual([`live`]));
    });

    it(`runs at once when Docker answers, whatever an older check says`, async () => {
        machine.dockerReady.value = true;
        const setup = await started();
        await setup.loadPending();
        expect(codesRun()).toEqual([`live`]);
        expect(setup.pcParked.value).toBe(false);
    });

    it(`offers this PC's setup, the same press as the Agents page's`, async () => {
        const setup = await started();
        await setup.loadPending();
        await setup.setUpThisPc();
        expect(pc.setUp.mock.calls).toEqual([[`device`]]);
        expect(setup.pcParked.value).toBe(true);
        expect(sent.some((said) => said.event === `desktop_install_pc_setup` && said.properties?.[`action`] === `pressed`)).toBe(true);
    });

    it(`is given up when the reader dismisses it, and the PC turning ready then runs nothing`, async () => {
        const setup = await started();
        await setup.loadPending();
        setup.closeSetup();
        expect(setup.pcParked.value).toBe(false);
        expect(asked(`forget_resumable_setup`)).toBe(1);
        await nextTick();
        expect(lastReport()).toMatchObject({ state: `closed` });
        pc.setup.value = { state: `ready` };
        pc.check.value = check(`ready`);
        await nextTick();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(codesRun()).toEqual([]);
    });

    it(`runs at once anywhere but Windows`, async () => {
        os = `linux`;
        const setup = await started();
        await setup.loadPending();
        expect(codesRun()).toEqual([`live`]);
        expect(setup.pcParked.value).toBe(false);
    });
});

describe(`the heartbeat`, () => {
    afterEach(() => jest.useRealTimers());

    it(`sends the report again every few seconds while the setup waits, and stops once it is closed`, async () => {
        jest.useFakeTimers();
        const setup = await started();
        await setup.loadPending();
        await nextTick();
        const before = reports().length;
        await advanceTimersByTimeAsync(4_000);
        expect(reports().length).toBe(before + 1);
        await advanceTimersByTimeAsync(4_000);
        expect(reports().length).toBe(before + 2);
        const [earlier, later] = reports().slice(-2);
        expect(later?.at).toBeGreaterThan(earlier?.at ?? Number.POSITIVE_INFINITY);
        setup.closeSetup();
        await nextTick();
        const closed = reports().length;
        await advanceTimersByTimeAsync(12_000);
        expect(reports().length).toBe(closed);
    });
});

describe(`a running pull`, () => {
    it(`tells the page its bytes and the estimate in seconds, and where it was left when the app quits`, async () => {
        os = `linux`;
        hold = true;
        const setup = await started();
        const running = setup.loadPending();
        await waitFor(() => expect(held).toBe(true));
        hear({ kind: `line`, run: `setup`, stream: `stdout`, text: `intentic: [pulling-image] using the sandbox image downloaded ahead of time` });
        hear({ kind: `line`, run: `setup`, stream: `stdout`, text: `      downloading the sandbox image: 800 of 2200 MB (9.0 MB/s)` });
        await nextTick();
        const told = lastReport();
        expect(told).toMatchObject({
            state: `running`,
            step: `pulling-image`,
            downloaded: 800 * 1024 * 1024,
            downloadTotal: 2200 * 1024 * 1024,
            at: expect.any(Number),
        });
        expect(Number.isInteger(told?.remainingSeconds)).toBe(true);

        // Half a minute on, ic's next reading brings the pull's report to the funnel: numbers only.
        expect(sent.some((said) => said.event === `desktop_install_progress`)).toBe(false);
        jest.setSystemTime(new Date(Date.now() + 31_000));
        hear({ kind: `line`, run: `setup`, stream: `stdout`, text: `      downloading the sandbox image: 1100 of 2200 MB (9.0 MB/s)` });
        expect(sent.find((said) => said.event === `desktop_install_progress`)?.properties).toMatchObject({
            step: `pulling-image`,
            downloadedMb: 1100,
            downloadTotalMb: 2200,
            bytesPerSecond: expect.any(Number),
            remainingSeconds: expect.any(Number),
        });
        jest.setSystemTime();

        expect(await setup.abandonOnQuit()).toBe(true);
        expect(sent.find((said) => said.event === `desktop_install_abandoned`)?.properties).toMatchObject({
            step: `pulling-image`,
            percent: expect.any(Number),
            elapsedSeconds: expect.any(Number),
            downloadedMb: 1100,
            downloadTotalMb: 2200,
        });

        finishRun?.();
        await running;
        // Nothing runs now: a quit has nothing to say about it.
        expect(await setup.abandonOnQuit()).toBe(false);
    });
});

/* The setup page took the sandbox to a machine of ours while this PC was still downloading it (2026-10-12): the machine
   adopts the sandbox's address, so a download left going ends in an announce the platform refuses, and a failed setup on
   a row that is hosted by then. The page asks the app to stop it (`intentic://setup-stop`), which the main window hears. */
describe(`a sandbox taken to a machine of ours`, () => {
    // A pull under way on the handed-over setup, held until the test ends it.
    const pulling = async () => {
        os = `linux`;
        hold = true;
        const setup = await started();
        const run = setup.loadPending();
        await waitFor(() => expect(held).toBe(true));
        hear({ kind: `line`, run: `setup`, stream: `stdout`, text: `intentic: [pulling-image] downloading the sandbox image` });
        return { setup, run };
    };
    const told = (event: string) => sent.filter((said) => said.event === event).map((said) => said.properties);

    it(`stops the install it runs for that sandbox as the card's Stop does, told as stopped, and stays off the page`, async () => {
        const { setup, run } = await pulling();
        await setup.stopForHosted(`cmsandbox0001`);
        await run;
        expect(calls.filter((call) => call.command === `run_stop`).map((call) => call.args)).toEqual([{ id: `setup` }]);
        expect(told(`desktop_install_stopped`)).toEqual([{ percent: expect.any(Number), reason: `hosted` }]);
        const [finished] = told(`desktop_install_finished`);
        expect(finished).toMatchObject({ ok: false, stopped: `hosted` });
        expect(finished).not.toHaveProperty(`reason`);
        expect(told(`desktop_install_step`).at(-1)).toMatchObject({ outcome: `stopped` });
        expect(setup.wasStopped.value).toBe(true);
        expect(setup.setupError.value).toBeUndefined();
        await nextTick();
        // Told as stopped, then the card put away: its "Try again" would set the now-hosted sandbox up on this PC too.
        expect(reports().map((said) => said.state).slice(-2)).toEqual([`stopped`, `closed`]);
        expect(lastReport()).toMatchObject({ state: `closed`, name: `work` });
        expect(setup.setupMode.value).toBe(false);
        // The reader is watching the machine of ours start: This device is not swapped in over that page.
        expect(asked(`setup_alert`)).toBe(0);
    });

    it(`does nothing for another sandbox, nor with no install running`, async () => {
        const idle = await started();
        await idle.stopForHosted(`cmsandbox0001`);
        expect(asked(`run_stop`)).toBe(0);

        const { setup, run } = await pulling();
        await setup.stopForHosted(`cmsandbox0002`);
        expect(asked(`run_stop`)).toBe(0);
        expect(told(`desktop_install_stopped`)).toEqual([]);
        expect(setup.stopping.value).toBe(false);
        finishRun?.();
        await run;
        await setup.stopForHosted(`cmsandbox0001`);
        expect(asked(`run_stop`)).toBe(0);
    });

    it(`leaves the card's own Stop as it was: said to be the card's, and This device brought back with the run`, async () => {
        const { setup, run } = await pulling();
        await setup.stopSetup();
        await run;
        expect(told(`desktop_install_stopped`)).toEqual([{ percent: expect.any(Number), reason: `card` }]);
        expect(told(`desktop_install_finished`)[0]).toMatchObject({ stopped: `card` });
        expect(asked(`setup_alert`)).toBe(1);
    });
});
