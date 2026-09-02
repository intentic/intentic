import type { CommandRun } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createRunWatcher, type RunSource } from "./runWatcher";

/* THE WATCHER'S OWN PROMISES, the ones the pre-push check and the push both ride on: the reveal happens once,
 * at the first state that names a terminal; a dropped poll is reported and does not end the wait; forgetting a
 * run stops the follow without killing the run; and a start the daemon refused rests with the reason. */

const openFocused = vi.fn();
vi.mock(`../terminal/useTerminalPanel`, () => ({ useTerminalPanel: () => ({ openFocused }) }));

const IDLE: CommandRun = { status: `idle`, command: ``, output: `` };
const running = (session?: string): CommandRun => ({ status: `running`, command: `pnpm check`, output: ``, ...(session === undefined ? {} : { session }) });
const passed: CommandRun = { status: `passed`, command: `pnpm check`, output: ``, exitCode: 0, session: `job-checks` };

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
        reveal: (run) => ({ title: `Running your pre-push check`, detail: run.command }),
        subject: `checks`,
    };
    return { source, calls };
};

beforeEach(() => {
    vi.useFakeTimers();
    openFocused.mockClear();
});
afterEach(() => {
    vi.useRealTimers();
});

// Every poll after the first sits behind the interval; this walks the clock past as many as a script needs.
const settle = async <T,>(pending: Promise<T>, polls: number): Promise<T> => {
    for (let i = 0; i < polls; i += 1) {
        await vi.advanceTimersByTimeAsync(700);
    }
    return pending;
};

test(`start follows the run to its verdict and opens the terminal once, at the first state that names it`, async () => {
    const { source, calls } = scripted([running(), running(`job-checks`), running(`job-checks`), passed]);
    const watcher = createRunWatcher(source);
    expect(watcher.run.value).toEqual(IDLE);

    const pending = watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watcher.running.value).toBe(true);
    expect(watcher.terminal.value).toBeUndefined();

    const settled = await settle(pending, 3);
    expect(settled).toEqual(passed);
    expect(watcher.run.value).toEqual(passed);
    expect(watcher.running.value).toBe(false);
    expect(calls).toEqual({ start: 1, cancel: 0, state: 4 });
    expect(openFocused).toHaveBeenCalledTimes(1);
    expect(openFocused).toHaveBeenCalledWith(`job-checks`, { title: `Running your pre-push check`, detail: `pnpm check` });
});

test(`a dropped poll is reported and the follow goes on; the next answer clears it`, async () => {
    const { source } = scripted([running(`job-checks`), `throw`, passed]);
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
    const { source, calls } = scripted([running(`job-checks`)]);
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
    await vi.advanceTimersByTimeAsync(0);
    expect(openFocused).not.toHaveBeenCalled();
    await watcher.start();
    await vi.advanceTimersByTimeAsync(0);
    openFocused.mockClear();
    watcher.showTerminal();
    // The panel is reached lazily (a dynamic import, see runWatcher.ts), so the open lands a tick later.
    await vi.advanceTimersByTimeAsync(0);
    expect(openFocused).toHaveBeenCalledWith(`job-checks`, { title: `Running your pre-push check`, detail: `pnpm check` });
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

// A run on another box has no panel here to open (usePushRun.ts aims the ledger's pushes at that box): the
// source says so by answering no words, and the watcher follows the run without touching the panel.
test(`a source with no panel to open follows the run and reveals nothing`, async () => {
    const { source } = scripted([running(`job-checks`), passed]);
    const watcher = createRunWatcher({ ...source, reveal: () => undefined });
    const settled = await settle(watcher.start(), 1);
    expect(settled).toEqual(passed);
    watcher.showTerminal();
    await vi.advanceTimersByTimeAsync(0);
    expect(openFocused).not.toHaveBeenCalled();
    expect(watcher.terminal.value).toBe(`job-checks`);
});
