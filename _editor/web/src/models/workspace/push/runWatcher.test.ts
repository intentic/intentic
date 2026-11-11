import type { CommandRun } from "@intentic/sandbox-contract/schemas/ci";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { quietRunRows } from "../../terminal/quietRuns";
import { createRunWatcher, type RunSource } from "./runWatcher";

/* THE WATCHER'S OWN PROMISES, the ones a push rides on: the reveal happens once, at the first state that names a terminal,
   or for a quiet source only when the run fails or is taking long. */

const panelOpen = { value: false };
const openFocused = jest.fn(() => {
    panelOpen.value = true;
});
const setOpen = jest.fn((open: boolean) => {
    panelOpen.value = open;
});
jest.mock(`../../terminal/useTerminalPanel`, () => ({ useTerminalPanel: () => ({ openFocused, setOpen, open: panelOpen }) }));

const IDLE: CommandRun = { status: `idle`, command: ``, output: `` };
const running = (session?: string): CommandRun => ({
    status: `running`,
    command: `git push origin main`,
    output: ``,
    ...(session === undefined ? {} : { session }),
});
const passed: CommandRun = { status: `passed`, command: `git push origin main`, output: ``, exitCode: 0, session: `job-push` };
const failed: CommandRun = { status: `failed`, command: `git push origin main`, output: `rejected`, exitCode: 1, session: `job-push` };
const cancelled: CommandRun = { status: `cancelled`, command: `git push origin main`, output: ``, session: `job-push` };

// A source that answers `state` from a script of states (or throws where the script says `throw`), and counts
// what was asked of it.
const scripted = (states: readonly (CommandRun | `throw`)[]) => {
    let next = 0;
    const calls = { start: 0, cancel: 0, state: 0 };
    const source: RunSource<CommandRun> = {
        idle: IDLE,
        start: async () => {
            calls.start += 1;
        },
        state: async () => {
            calls.state += 1;
            const state = states[Math.min(next, states.length - 1)]!;
            next += 1;
            if (state === `throw`) {
                throw new Error(`tunnel dropped`);
            }
            return state;
        },
        cancel: async () => {
            calls.cancel += 1;
        },
        reveal: (run) => ({ title: `Pushing intentic`, detail: run.command }),
        says: {
            startFailed: () => `Could not start the push.`,
            lostContact: () => `Lost contact with the push.`,
            stopFailed: () => `Could not stop the push.`,
        },
    };
    return { source, calls };
};

beforeEach(() => {
    jest.useFakeTimers();
    openFocused.mockClear();
    setOpen.mockClear();
    panelOpen.value = false;
});
afterEach(() => {
    jest.useRealTimers();
});

// Every poll after the first sits behind the interval; this walks the clock past as many as a script needs.
const settle = async <T>(pending: Promise<T>, polls: number): Promise<T> => {
    for (let i = 0; i < polls; i += 1) {
        await advanceTimersByTimeAsync(700);
    }
    return pending;
};

test(`start follows the run to its verdict and opens the terminal once, at the first state that names it`, async () => {
    const { source, calls } = scripted([running(), running(`job-push`), running(`job-push`), passed]);
    const watcher = createRunWatcher(source);
    expect(watcher.run.value).toEqual(IDLE);

    const pending = watcher.start();
    await advanceTimersByTimeAsync(0);
    expect(watcher.running.value).toBe(true);
    expect(watcher.terminal.value).toBeUndefined();

    const settled = await settle(pending, 3);
    expect(settled).toEqual(passed);
    expect(watcher.run.value).toEqual(passed);
    expect(watcher.running.value).toBe(false);
    expect(calls).toEqual({ start: 1, cancel: 0, state: 4 });
    expect(openFocused).toHaveBeenCalledTimes(1);
    expect(openFocused).toHaveBeenCalledWith(`job-push`, { title: `Pushing intentic`, detail: `git push origin main` });
});

test(`a dropped poll is reported and the follow goes on; the next answer clears it`, async () => {
    const { source } = scripted([running(`job-push`), `throw`, passed]);
    const watcher = createRunWatcher(source);
    const pending = watcher.start();
    await settle(Promise.resolve(), 1);
    expect(watcher.error.value).toBe(`tunnel dropped`);
    expect(watcher.running.value).toBe(true);

    const settled = await settle(pending, 1);
    expect(settled).toEqual(passed);
    expect(watcher.error.value).toBeUndefined();
});

test(`forgetting a run stops the follow and rests, without touching the daemon`, async () => {
    const { source, calls } = scripted([running(`job-push`)]);
    const watcher = createRunWatcher(source);
    const pending = watcher.start();
    await settle(Promise.resolve(), 2);
    const asked = calls.state;
    watcher.forget();
    expect(await pending).toEqual(IDLE);
    await settle(Promise.resolve(), 3);
    expect(calls.state).toBe(asked);
    expect(calls.cancel).toBe(0);
    expect(watcher.run.value).toEqual(IDLE);
});

test(`a start the daemon refused rests with the reason, and asks nothing more`, async () => {
    const { source, calls } = scripted([passed]);
    const refusing: RunSource<CommandRun> = {
        ...source,
        start: async () => {
            throw new Error(`503`);
        },
    };
    const watcher = createRunWatcher(refusing);
    expect(await watcher.start()).toEqual(IDLE);
    expect(watcher.error.value).toBe(`503`);
    expect(calls.state).toBe(0);
});

test(`showTerminal opens the run's terminal again on request, and nothing where there is none`, async () => {
    const { source } = scripted([passed]);
    const watcher = createRunWatcher(source);
    watcher.showTerminal();
    await advanceTimersByTimeAsync(0);
    expect(openFocused).not.toHaveBeenCalled();
    await watcher.start();
    await advanceTimersByTimeAsync(0);
    openFocused.mockClear();
    watcher.showTerminal();
    // The panel is reached lazily (a dynamic import, see runWatcher.ts), so the open lands a tick later.
    await advanceTimersByTimeAsync(0);
    expect(openFocused).toHaveBeenCalledWith(`job-push`, { title: `Pushing intentic`, detail: `git push origin main` });
});

test(`cancel asks the daemon to stop and keeps a refusal as the error line`, async () => {
    const { source, calls } = scripted([passed]);
    const watcher = createRunWatcher(source);
    await watcher.cancel();
    expect(calls.cancel).toBe(1);
    const stubborn = createRunWatcher({
        ...source,
        cancel: async () => {
            throw new Error(`no such run`);
        },
    });
    await stubborn.cancel();
    expect(stubborn.error.value).toBe(`no such run`);
});

// A run with no panel here to open: the source says so by answering no words, and the watcher follows the run without touching the panel.
test(`a source with no panel to open follows the run and reveals nothing`, async () => {
    const { source } = scripted([running(`job-push`), passed]);
    const watcher = createRunWatcher({ ...source, reveal: () => undefined });
    const settled = await settle(watcher.start(), 1);
    expect(settled).toEqual(passed);
    watcher.showTerminal();
    await advanceTimersByTimeAsync(0);
    expect(openFocused).not.toHaveBeenCalled();
    expect(watcher.terminal.value).toBe(`job-push`);
});

/* QUIET RUNS: a push is pressed too often to open the panel each time, so it opens only when there is something to read. */

const QUIET = { slowMs: 20_000, row: () => ({ label: `Pushing`, value: `intentic` }) };
const QUIET_POLLS = Math.ceil(QUIET.slowMs / 700);

test(`a quiet run that passes opens nothing, and is said on the terminal tile only while it goes`, async () => {
    const { source } = scripted([running(`job-push`), running(`job-push`), passed]);
    const watcher = createRunWatcher({ ...source, quiet: QUIET });
    const pending = watcher.start();
    await advanceTimersByTimeAsync(0);
    expect(quietRunRows()).toEqual([{ label: `Pushing`, value: `intentic` }]);
    expect(await settle(pending, 2)).toEqual(passed);
    await advanceTimersByTimeAsync(0);
    expect(openFocused).not.toHaveBeenCalled();
    expect(quietRunRows()).toEqual([]);
    // The terminal is still there to ask for.
    expect(watcher.terminal.value).toBe(`job-push`);
});

test(`a quiet run that fails opens its terminal, once, on the verdict`, async () => {
    const { source } = scripted([running(`job-push`), failed]);
    const watcher = createRunWatcher({ ...source, quiet: QUIET });
    expect(await settle(watcher.start(), 1)).toEqual(failed);
    await advanceTimersByTimeAsync(0);
    expect(openFocused).toHaveBeenCalledTimes(1);
    expect(openFocused).toHaveBeenCalledWith(`job-push`, { title: `Pushing intentic`, detail: `git push origin main` });
    expect(quietRunRows()).toEqual([]);
});

test(`a quiet run the reader stopped opens nothing`, async () => {
    const { source } = scripted([running(`job-push`), cancelled]);
    const watcher = createRunWatcher({ ...source, quiet: QUIET });
    await settle(watcher.start(), 1);
    await advanceTimersByTimeAsync(0);
    expect(openFocused).not.toHaveBeenCalled();
    expect(quietRunRows()).toEqual([]);
});

test(`a quiet run still going past its limit opens its terminal, and a pass closes the panel that opening found closed`, async () => {
    const { source } = scripted([...Array.from({ length: QUIET_POLLS + 1 }, () => running(`job-push`)), passed]);
    const watcher = createRunWatcher({ ...source, quiet: QUIET });
    const pending = watcher.start();
    await settle(Promise.resolve(), QUIET_POLLS - 1);
    expect(openFocused).not.toHaveBeenCalled();
    await settle(Promise.resolve(), 1);
    expect(openFocused).toHaveBeenCalledTimes(1);
    expect(panelOpen.value).toBe(true);
    // Still going after the reveal, so still said on the tile.
    expect(quietRunRows()).toHaveLength(1);
    expect(await settle(pending, 2)).toEqual(passed);
    await advanceTimersByTimeAsync(0);
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(panelOpen.value).toBe(false);
    expect(openFocused).toHaveBeenCalledTimes(1);
    expect(quietRunRows()).toEqual([]);
});

test(`a slow reveal into a panel the reader already had open leaves it open when the run passes`, async () => {
    panelOpen.value = true;
    const { source } = scripted([...Array.from({ length: QUIET_POLLS + 1 }, () => running(`job-push`)), passed]);
    const watcher = createRunWatcher({ ...source, quiet: QUIET });
    await settle(watcher.start(), QUIET_POLLS + 2);
    await advanceTimersByTimeAsync(0);
    expect(openFocused).toHaveBeenCalledTimes(1);
    expect(setOpen).not.toHaveBeenCalled();
});

test(`a slow run that then fails keeps the panel open on the failure`, async () => {
    const { source } = scripted([...Array.from({ length: QUIET_POLLS + 1 }, () => running(`job-push`)), failed]);
    const watcher = createRunWatcher({ ...source, quiet: QUIET });
    await settle(watcher.start(), QUIET_POLLS + 2);
    await advanceTimersByTimeAsync(0);
    expect(openFocused).toHaveBeenCalledTimes(1);
    expect(setOpen).not.toHaveBeenCalled();
});

test(`forgetting a quiet run takes it off the terminal tile`, async () => {
    const { source } = scripted([running(`job-push`)]);
    const watcher = createRunWatcher({ ...source, quiet: QUIET });
    const pending = watcher.start();
    await advanceTimersByTimeAsync(0);
    expect(quietRunRows()).toHaveLength(1);
    watcher.forget();
    await pending;
    expect(quietRunRows()).toEqual([]);
});
