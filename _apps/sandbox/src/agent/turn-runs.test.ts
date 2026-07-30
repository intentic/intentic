import type { AgentEvent, AgentTurn } from "@intentic/sandbox-contract";
import { describe, expect, it, vi } from "vitest";
import { commandsOf, resetCommands } from "./agent-commands.js";
import { startTurnRun, type TurnFn, turnRunOf } from "./turn-runs.js";

// A hand-cranked turn: the test pushes events (or a failure) and the run's pump consumes them as they land —
// the same push/pull shape SteeringQueue uses, so live-follow interleavings are exercised for real.
const crankedTurn = (): { turnFn: TurnFn; push: (event: AgentEvent) => void; fail: (error: Error) => void; close: () => void } => {
    const buffer: (AgentEvent | Error | typeof CLOSE)[] = [];
    const CLOSE = Symbol(`close`);
    let wake: (() => void) | undefined;
    const feed = (item: AgentEvent | Error | typeof CLOSE): void => {
        buffer.push(item);
        wake?.();
    };
    return {
        push: feed,
        fail: feed,
        close: () => feed(CLOSE),
        turnFn: async function* () {
            for (;;) {
                const next = buffer.shift();
                if (next === undefined) {
                    await new Promise<void>((resolve) => {
                        wake = resolve;
                    });
                    wake = undefined;
                    continue;
                }
                if (next === CLOSE) {
                    return;
                }
                if (next instanceof Error) {
                    throw next;
                }
                yield next;
            }
        },
    };
};

const turn = (conversationId: string): AgentTurn & { conversationId: string } => ({ prompt: `do the thing`, conversationId });

const collect = async (conversationId: string, after = 0): Promise<{ seq: number; event: AgentEvent }[]> => {
    const frames: { seq: number; event: AgentEvent }[] = [];
    for await (const frame of turnRunOf(conversationId)!.follow(after)) {
        frames.push(frame);
    }
    return frames;
};

describe(`turn runs`, () => {
    it(`streams live frames to a follower with 1-based seqs and settles at the turn's end`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = startTurnRun(turnFn, turn(`c-live`))!;
        expect(run.prompt).toBe(`do the thing`);

        const followed = collect(`c-live`);
        push({ kind: `delta`, text: `a` });
        push({ kind: `done` });
        close();

        expect(await followed).toEqual([
            { seq: 1, event: { kind: `delta`, text: `a` } },
            { seq: 2, event: { kind: `done` } },
        ]);
        expect(run.done).toBe(true);
    });

    it(`replays the full log to a late attach and only the tail to a cursor resume`, async () => {
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(turnFn, turn(`c-replay`));
        push({ kind: `delta`, text: `a` });
        push({ kind: `delta`, text: `b` });
        push({ kind: `delta`, text: `c` });
        close();
        await vi.waitFor(() => expect(turnRunOf(`c-replay`)!.done).toBe(true));

        expect((await collect(`c-replay`)).map((frame) => frame.seq)).toEqual([1, 2, 3]);
        expect(await collect(`c-replay`, 2)).toEqual([{ seq: 3, event: { kind: `delta`, text: `c` } }]);
    });

    it(`serves several concurrent followers — each gets every frame`, async () => {
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(turnFn, turn(`c-multi`));

        const first = collect(`c-multi`);
        push({ kind: `delta`, text: `a` });
        // The second follower attaches mid-run: replay of frame 1, then live for frame 2.
        await vi.waitFor(() => expect(turnRunOf(`c-multi`)!.seq).toBe(1));
        const second = collect(`c-multi`);
        push({ kind: `done` });
        close();

        expect((await first).map((frame) => frame.seq)).toEqual([1, 2]);
        expect((await second).map((frame) => frame.seq)).toEqual([1, 2]);
    });

    it(`refuses a second start while the run is live, allows one after it settles`, async () => {
        const { turnFn, close } = crankedTurn();
        const first = startTurnRun(turnFn, turn(`c-busy`))!;
        expect(startTurnRun(turnFn, turn(`c-busy`))).toBeUndefined();

        close();
        await vi.waitFor(() => expect(first.done).toBe(true));
        const { turnFn: nextTurnFn, close: closeNext } = crankedTurn();
        const second = startTurnRun(nextTurnFn, turn(`c-busy`))!;
        expect(second.id).not.toBe(first.id);
        // The new run replaced the retained one under the conversation key.
        expect(turnRunOf(`c-busy`)!.id).toBe(second.id);
        closeNext();
    });

    it(`folds a thrown turn into an error frame and an abort into a clean done`, async () => {
        const { turnFn, fail } = crankedTurn();
        startTurnRun(turnFn, turn(`c-throw`));
        fail(new Error(`adapter exploded`));
        await vi.waitFor(() => expect(turnRunOf(`c-throw`)!.done).toBe(true));
        expect((await collect(`c-throw`)).map((frame) => frame.event)).toEqual([{ kind: `error`, message: `adapter exploded` }, { kind: `done` }]);

        const { turnFn: abortFn, fail: abort } = crankedTurn();
        startTurnRun(abortFn, turn(`c-abort`));
        abort(new DOMException(`aborted`, `AbortError`) as unknown as Error);
        await vi.waitFor(() => expect(turnRunOf(`c-abort`)!.done).toBe(true));
        expect((await collect(`c-abort`)).map((frame) => frame.event)).toEqual([{ kind: `done` }]);
    });

    it(`drops a finished run after retention — attach then finds nothing`, async () => {
        vi.useFakeTimers();
        try {
            const { turnFn, close } = crankedTurn();
            startTurnRun(turnFn, turn(`c-retain`));
            close();
            await vi.waitFor(() => expect(turnRunOf(`c-retain`)!.done).toBe(true));

            vi.advanceTimersByTime(4 * 60_000);
            expect(turnRunOf(`c-retain`)).toBeDefined();
            vi.advanceTimersByTime(2 * 60_000);
            expect(turnRunOf(`c-retain`)).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    /* THE JOURNAL — one entry per in-flight turn, so a daemon death leaves behind exactly what to re-run.
     *
     * The fake makes every write SLOW and records completion order, which is the whole point of these two. None
     * of the writes may block the caller (the route acks the run id synchronously), so they all run detached —
     * but they must not overtake each other either. A clear that beat the opening write would unlink a file that
     * does not exist yet; a clear that beat the session-frame update would be followed by that update
     * re-creating the entry. Either way a journal entry outlives its turn, and the next boot resumes a turn that
     * already finished. */
    // A write costs more than an unlink, here as on a real disk — which is exactly what makes the ordering bug
    // reachable rather than theoretical: fired independently, the clear WINS, and then a write lands after it.
    const fakeJournal = (writeMs = 20, clearMs = 1) => {
        const calls: string[] = [];
        const after = async (ms: number, label: string): Promise<void> => {
            await new Promise((resolve) => setTimeout(resolve, ms));
            calls.push(label);
        };
        return {
            calls,
            journal: {
                list: async () => [],
                recordTurn: (entry: { sessionId?: string }) => after(writeMs, entry.sessionId === undefined ? `record` : `record:${entry.sessionId}`),
                recordFire: async () => undefined,
                clearTurn: (conversationId: string) => after(clearMs, `clear:${conversationId}`),
                clearFire: async () => undefined,
            },
        };
    };

    it(`journals the in-flight turn, folds in its session, and clears LAST however slow the writes are`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const { calls, journal } = fakeJournal();
        startTurnRun(turnFn, turn(`c-journal`), { journal });

        // The turn settles well inside a single write's duration — the window where an unserialized clear wins.
        push({ kind: `session`, sessionId: `sess-7` });
        push({ kind: `done` });
        close();
        await vi.waitFor(() => expect(turnRunOf(`c-journal`)!.done).toBe(true));

        await vi.waitFor(() => expect(calls).toEqual([`record`, `record:sess-7`, `clear:c-journal`]));
        // And it STAYS cleared: nothing lands after the clear to re-create the entry.
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(calls).toEqual([`record`, `record:sess-7`, `clear:c-journal`]);
    });

    it(`clears the entry for a FAILED turn too — only a turn nobody saw the end of deserves resuming`, async () => {
        const { turnFn, fail } = crankedTurn();
        const { calls, journal } = fakeJournal();
        startTurnRun(turnFn, turn(`c-journal-fail`), { journal });
        fail(new Error(`adapter exploded`));
        await vi.waitFor(() => expect(turnRunOf(`c-journal-fail`)!.done).toBe(true));

        await vi.waitFor(() => expect(calls).toEqual([`record`, `clear:c-journal-fail`]));
    });

    it(`a journal that throws cannot break the turn`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const broken = {
            list: async () => [],
            recordTurn: () => Promise.reject(new Error(`disk full`)),
            recordFire: () => Promise.reject(new Error(`disk full`)),
            clearTurn: () => Promise.reject(new Error(`disk full`)),
            clearFire: () => Promise.reject(new Error(`disk full`)),
        };
        startTurnRun(turnFn, turn(`c-journal-broken`), { journal: broken });

        const followed = collect(`c-journal-broken`);
        push({ kind: `session`, sessionId: `sess-9` });
        push({ kind: `done` });
        close();
        expect((await followed).map((frame) => frame.event.kind)).toEqual([`session`, `done`]);
    });

    it(`caches each provider's published commands so a conversation that hasn't run a turn can read them`, async () => {
        resetCommands();
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(turnFn, { ...turn(`c-commands`), agent: `kimi` });

        const followed = collect(`c-commands`);
        push({ kind: `commands`, items: [{ name: `review`, description: `Review a PR` }] });
        // Replace-wholesale, matching the frame's own semantics: the later list wins outright.
        push({ kind: `commands`, items: [{ name: `deploy`, description: `Ship it` }] });
        push({ kind: `done` });
        close();
        await followed;

        expect(commandsOf(`kimi`)).toEqual([{ name: `deploy`, description: `Ship it` }]);
        // Keyed by provider — a turn on one never answers for another. An absent `agent` means claude.
        expect(commandsOf(`claude`)).toEqual([]);
    });
});
