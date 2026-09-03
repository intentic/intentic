import type { AgentEvent, AgentTurn } from "@intentic/sandbox-contract";
import { describe, expect, it, vi } from "vitest";
import type { JournalEntry } from "./turn-journal.js";
import { commandsOf, resetCommands } from "./agent-commands.js";
import { type AttachEntry, type AttachHead, startTurnRun, type TurnFn, turnRunOf } from "./turn-runs.js";

// A hand-cranked turn: the test pushes events (or a failure) and the run's pump consumes them as they land:
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
        async *turnFn() {
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
const opening = () => [{ role: `user` as const, text: `do the thing`, sentAt: 1 }];

// Attach and drain: the head, then everything until the run finishes.
const collect = async (conversationId: string): Promise<{ head: AttachHead; entries: AttachEntry[] }> => {
    const { head, entries } = turnRunOf(conversationId)!.attach();
    const drained: AttachEntry[] = [];
    for await (const entry of entries) {
        drained.push(entry);
    }
    return { head, entries: drained };
};

describe(`turn runs`, () => {
    it(`opens with the turn's rows, streams changes to them and facts about it with 1-based seqs, and settles at the turn's end`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = startTurnRun(turnFn, turn(`c-live`), { opening })!;
        expect(run.rows).toEqual([{ role: `user`, text: `do the thing`, sentAt: 1 }]);

        const followed = collect(`c-live`);
        push({ kind: `session`, sessionId: `s1` });
        push({ kind: `delta`, text: `a` });
        push({ kind: `done` });
        close();

        const { head, entries } = await followed;
        expect(head).toEqual({
            kind: `attached`,
            run: run.id,
            startedAt: run.startedAt,
            seq: 0,
            rows: [{ role: `user`, text: `do the thing`, sentAt: 1 }],
        });
        expect(entries).toEqual([
            { kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `s1` } },
            { kind: `patch`, seq: 2, patch: { op: `append`, row: { role: `assistant`, text: `` } } },
            { kind: `patch`, seq: 3, patch: { op: `text`, index: 1, text: `a` } },
        ]);
        expect(run.done).toBe(true);
        expect(run.rows).toEqual([
            { role: `user`, text: `do the thing`, sentAt: 1 },
            { role: `assistant`, text: `a` },
        ]);
    });

    /* A LATE ATTACH gets the rows whole and nothing it already holds again: the head carries the transcript as
     * it stands, the facts replay behind it (a window joining late still has to learn the session), and only
     * what lands afterwards streams. */
    it(`hands a late attach the rows so far and the facts, then only what follows`, async () => {
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(turnFn, turn(`c-replay`), { opening });
        push({ kind: `session`, sessionId: `s1` });
        push({ kind: `delta`, text: `a` });
        push({ kind: `delta`, text: `b` });
        await vi.waitFor(() => expect(turnRunOf(`c-replay`)!.rows[1]?.text).toBe(`ab`));

        const followed = collect(`c-replay`);
        push({ kind: `delta`, text: `c` });
        close();
        const { head, entries } = await followed;
        expect(head.seq).toBe(4);
        expect(head.rows).toEqual([
            { role: `user`, text: `do the thing`, sentAt: 1 },
            { role: `assistant`, text: `ab` },
        ]);
        expect(entries).toEqual([
            { kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `s1` } },
            { kind: `patch`, seq: 5, patch: { op: `text`, index: 1, text: `c` } },
        ]);
    });

    it(`serves several concurrent followers: each gets every change from its own head on`, async () => {
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(turnFn, turn(`c-multi`), { opening });

        const first = collect(`c-multi`);
        push({ kind: `delta`, text: `a` });
        await vi.waitFor(() => expect(turnRunOf(`c-multi`)!.rows).toHaveLength(2));
        // The second follower attaches mid-run: the row so far on its head, then live for the rest.
        const second = collect(`c-multi`);
        push({ kind: `delta`, text: `b` });
        close();

        expect((await first).entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        const late = await second;
        expect(late.head.rows[1]?.text).toBe(`a`);
        expect(late.entries.map((entry) => entry.seq)).toEqual([3]);
    });

    // The raw frames, for the daemon's own readers: what the provider said, from the moment of subscribing.
    it(`hands its raw frames to a listener from the moment it subscribes`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = startTurnRun(turnFn, turn(`c-frames`))!;
        const frames: AgentEvent[] = [];
        const listening = (async () => {
            for await (const event of run.frames()) {
                frames.push(event);
            }
        })();
        push({ kind: `delta`, text: `a` });
        push({ kind: `done` });
        close();
        await listening;
        expect(frames).toEqual([{ kind: `delta`, text: `a` }, { kind: `done` }]);
    });

    it(`exposes a settlement barrier that does not resolve on an intermediate frame`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = startTurnRun(turnFn, turn(`c-wait`))!;
        let settled = false;
        const waiting = run.waitUntilFinished().then(() => {
            settled = true;
        });

        push({ kind: `delta`, text: `still unwinding` });
        await vi.waitFor(() => expect(run.rows).toHaveLength(1));
        expect(settled).toBe(false);

        close();
        await waiting;
        expect(settled).toBe(true);
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

    /* A THROWN TURN folds into the rows as the failure it was, and an abort as a stop: both are things the user
     * watched happen and will look for when they come back, so both are rows, and the record keeps them. */
    it(`folds a thrown turn into a failure line and an abort into a stop`, async () => {
        const { turnFn, fail } = crankedTurn();
        startTurnRun(turnFn, turn(`c-throw`), { opening });
        fail(new Error(`adapter exploded`));
        await vi.waitFor(() => expect(turnRunOf(`c-throw`)!.done).toBe(true));
        expect(turnRunOf(`c-throw`)!.rows.at(-1)).toEqual({ role: `notice`, text: `adapter exploded` });
        expect((await collect(`c-throw`)).entries).toEqual([{ kind: `fact`, seq: 2, fact: { kind: `error`, message: `adapter exploded` } }]);

        const { turnFn: abortFn, fail: abort } = crankedTurn();
        startTurnRun(abortFn, turn(`c-abort`), { opening });
        abort(new DOMException(`aborted`, `AbortError`) as unknown as Error);
        await vi.waitFor(() => expect(turnRunOf(`c-abort`)!.done).toBe(true));
        expect(turnRunOf(`c-abort`)!.rows.at(-1)).toEqual({ role: `notice`, text: `Stopped.` });
        expect((await collect(`c-abort`)).entries).toEqual([]);
    });

    // A card the turn was parked on when it was stopped is nobody's decision, and the stop says so.
    it(`freezes a card the stop caught pending, before the stop's own line`, async () => {
        const { turnFn, push, fail } = crankedTurn();
        startTurnRun(turnFn, turn(`c-park-stop`), { opening });
        push({ kind: `question`, requestId: `q1`, questions: [] });
        await vi.waitFor(() => expect(turnRunOf(`c-park-stop`)!.rows).toHaveLength(2));
        fail(new DOMException(`aborted`, `AbortError`) as unknown as Error);
        await vi.waitFor(() => expect(turnRunOf(`c-park-stop`)!.done).toBe(true));
        expect(turnRunOf(`c-park-stop`)!.rows.slice(1)).toEqual([
            { role: `assistant`, text: ``, question: { requestId: `q1`, questions: [], status: `cancelled` } },
            { role: `notice`, text: `Stopped.` },
        ]);
    });

    // A row the daemon writes on the turn's behalf lands where the transcript stands, for every follower.
    it(`takes a note the daemon writes, as a row every follower sees`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = startTurnRun(turnFn, turn(`c-note`), { opening })!;
        const followed = collect(`c-note`);
        push({ kind: `plan`, requestId: `p1`, text: `the plan` });
        await vi.waitFor(() => expect(run.rows).toHaveLength(2));
        // The decision settles the card through the turn's own frame; the daemon's line about it follows.
        push({ kind: `resolved`, requestId: `p1`, reply: { kind: `plan`, requestId: `p1`, approve: true } });
        await vi.waitFor(() => expect(run.rows[1]?.plan?.status).toBe(`approved`));
        run.note({ role: `notice`, text: `Plan approved.` });
        close();
        expect((await followed).entries.slice(-2)).toEqual([
            {
                kind: `patch`,
                seq: 3,
                patch: {
                    op: `replace`,
                    index: 1,
                    row: { role: `assistant`, text: ``, plan: { requestId: `p1`, text: `the plan`, status: `approved` } },
                },
            },
            { kind: `patch`, seq: 4, patch: { op: `append`, row: { role: `notice`, text: `Plan approved.` } } },
        ]);
    });

    // A helper's frames fold into a transcript of their own, read by the call that spawned it.
    it(`keeps one transcript per helper, out of the same frames`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = startTurnRun(turnFn, turn(`c-child`), { opening })!;
        push({ kind: `tool_call`, id: `task-1`, name: `Agent`, category: `other`, status: `in_progress` });
        push({ kind: `delta`, text: `child prose`, parentToolUseId: `task-1` });
        close();
        await vi.waitFor(() => expect(run.done).toBe(true));
        expect(run.rowsOf(`task-1`)).toEqual([{ role: `assistant`, text: `child prose` }]);
        expect(run.rowsOf(`nobody`)).toEqual([]);
    });

    it(`drops a finished run after retention: attach then finds nothing`, async () => {
        vi.useFakeTimers();
        try {
            const { turnFn, close } = crankedTurn();
            startTurnRun(turnFn, turn(`c-retain`));
            close();
            await vi.waitFor(() => expect(turnRunOf(`c-retain`)!.done).toBe(true));

            vi.advanceTimersByTime(45_000);
            expect(turnRunOf(`c-retain`)).toEqual(expect.any(Object));
            vi.advanceTimersByTime(20_000);
            expect(turnRunOf(`c-retain`)).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it(`finishes transcript preparation before invoking the provider`, async () => {
        let release!: () => void;
        const before = new Promise<void>((resolve) => {
            release = resolve;
        });
        let invoked = false;
        const run = startTurnRun(
            async function* () {
                invoked = true;
                yield { kind: `done` };
            },
            turn(`c-before`),
            { before },
        )!;

        await Promise.resolve();
        expect(invoked).toBe(false);
        release();
        await vi.waitFor(() => expect(run.done).toBe(true));
        expect(invoked).toBe(true);
    });

    // The settled turn is handed to the record as the rows the run folded, with where the steers landed.
    it(`hands the settled rows and the steered positions to the transcript sink`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const transcript = vi.fn(async () => true);
        startTurnRun(turnFn, turn(`c-sink`), { opening, transcript });
        push({ kind: `delta`, text: `a` });
        push({ kind: `steer`, text: `and`, sentAt: 2 });
        close();
        await vi.waitFor(() => expect(transcript).toHaveBeenCalledOnce());
        expect(transcript).toHaveBeenCalledWith(
            [
                { role: `user`, text: `do the thing`, sentAt: 1 },
                { role: `assistant`, text: `a` },
                { role: `user`, text: `and`, sentAt: 2 },
            ],
            [2],
        );
    });

    /* THE JOURNAL: one entry per in-flight turn, so a daemon death leaves behind exactly what to re-run.
     *
     * The fake makes every write SLOW and records completion order, which is the whole point of these two. None
     * of the writes may block the caller (the route acks the run id synchronously), so they all run detached:
     * but they must not overtake each other either. A clear that beat the opening write would unlink a file that
     * does not exist yet; a clear that beat the session-frame update would be followed by that update
     * re-creating the entry. Either way a journal entry outlives its turn, and the next boot resumes a turn that
     * already finished. */
    // A write costs more than an unlink, here as on a real disk, which is exactly what makes the ordering bug
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
                recordTurn: (entry: JournalEntry & { kind: "turn" }) =>
                    after(writeMs, entry.sessionId === undefined ? `record` : `record:${entry.sessionId}`),
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

        // The turn settles well inside a single write's duration: the window where an unserialized clear wins.
        push({ kind: `session`, sessionId: `sess-7` });
        push({ kind: `done` });
        close();
        await vi.waitFor(() => expect(turnRunOf(`c-journal`)!.done).toBe(true));

        await vi.waitFor(() => expect(calls).toEqual([`record`, `record:sess-7`, `clear:c-journal`]));
        // And it STAYS cleared: nothing lands after the clear to re-create the entry.
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(calls).toEqual([`record`, `record:sess-7`, `clear:c-journal`]);
    });

    it(`clears the entry for a FAILED turn too: only a turn nobody saw the end of deserves resuming`, async () => {
        const { turnFn, fail } = crankedTurn();
        const { calls, journal } = fakeJournal();
        startTurnRun(turnFn, turn(`c-journal-fail`), { journal });
        fail(new Error(`adapter exploded`));
        await vi.waitFor(() => expect(turnRunOf(`c-journal-fail`)!.done).toBe(true));

        await vi.waitFor(() => expect(calls).toEqual([`record`, `clear:c-journal-fail`]));
    });

    it(`does not clear the recovery journal until the transcript append has committed`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const { calls, journal } = fakeJournal();
        let commit!: () => void;
        const transcript = vi.fn(
            () =>
                new Promise<boolean>((resolve) => {
                    commit = () => resolve(true);
                }),
        );
        startTurnRun(turnFn, turn(`c-transcript-commit`), { journal, transcript });
        push({ kind: `done` });
        close();

        await vi.waitFor(() => expect(transcript).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(calls).toEqual([`record`]));
        commit();
        await vi.waitFor(() => expect(calls).toEqual([`record`, `clear:c-transcript-commit`]));
    });

    /* THE PARKED CARDS ride the journal entry while they are up: they are what a boot restores when the daemon
     * dies under a park (turn-resume.ts), and their content exists nowhere else once the run dies with the
     * process. Every rewrite carries the whole live state (session AND cards), so neither update can erase the
     * other's half. */
    it(`journals a raised card, keeps the session beside it, and takes the card back off when it resolves`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const entries: (JournalEntry & { kind: "turn" })[] = [];
        const journal = {
            list: async () => [],
            recordTurn: async (entry: JournalEntry & { kind: "turn" }) => {
                entries.push(entry);
            },
            recordFire: async () => undefined,
            clearTurn: async () => undefined,
            clearFire: async () => undefined,
        };
        startTurnRun(turnFn, turn(`c-parked`), { journal });

        push({ kind: `session`, sessionId: `sess-3` });
        push({ kind: `plan`, requestId: `r-plan`, text: `the plan` });
        push({ kind: `question`, requestId: `r-q`, questions: [{ question: `which?`, header: `Pick`, multiSelect: false, options: [] }] });
        // Both handovers park the turn and neither is ever journalled: the browser one's Chromium and the
        // terminal one's waiting command both die with the container, so there is nothing to restore them to.
        push({ kind: `browser_help`, requestId: `r-b`, session: `b-1`, account: `acc`, message: `captcha` });
        push({ kind: `terminal_help`, requestId: `r-t`, session: `agent-t1`, message: `type the one-time password` });
        push({ kind: `resolved`, requestId: `r-plan` });
        push({ kind: `done` });
        close();
        await vi.waitFor(() => expect(turnRunOf(`c-parked`)!.done).toBe(true));

        const parked = entries.map((entry) => ({ session: entry.sessionId, cards: (entry.parked ?? []).map((card) => card.requestId) }));
        expect(parked).toEqual([
            { session: undefined, cards: [] }, // the opening write
            { session: `sess-3`, cards: [] },
            { session: `sess-3`, cards: [`r-plan`] },
            { session: `sess-3`, cards: [`r-plan`, `r-q`] },
            { session: `sess-3`, cards: [`r-q`] }, // the plan resolved; the question still stands
        ]);
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
        expect((await followed).entries).toEqual([{ kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `sess-9` } }]);
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
        // Keyed by provider: a turn on one never answers for another. An absent `agent` means claude.
        expect(commandsOf(`claude`)).toEqual([]);
    });
});
