import type { AgentEvent, AgentTurn } from "@intentic/sandbox-contract";
import { describe, expect, it, vi } from "vitest";
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
        expect((await collect(`c-throw`)).map((frame) => frame.event)).toEqual([
            { kind: `error`, message: `adapter exploded` },
            { kind: `done` },
        ]);

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
});
