import type { AgentEvent } from "@intentic/sandbox-contract";
import { waitFor } from "@intentic/testing/bun";
import type { BeginRefusal } from "../../../agents/actor/conversation-decide.js";
import type { JournalledTurn } from "./turn-journal.js";
import { type AttachEntry, type AttachHead, turnRunOf } from "../../../agents/actor/conversation-holdings.js";
import { createDomainEvents, type DomainEventMap } from "../../../seams/domain-events.js";
import type { SentTurn, TurnStarter } from "../../../seams/turn-starter.js";
import { openConversationsDb } from "../../../store/conversations-db.js";
import { IN_MEMORY } from "../../../store/sqlite.js";
import { beginTurn, fleetStoreOver, memoryFleet } from "../../../testing.js";
import { commandsOf, resetCommands } from "../../providers/agent-commands.js";
import { MAX_BACKLOG_FRAMES } from "../../../seams/frame-backlog.js";
import { startTurnRun, type TurnRun } from "./turn-runs.js";

// Where every run here is filed and announced: one fleet's actors, one bus.
const deps = { conversations: memoryFleet().conversations, events: createDomainEvents(() => {}) };

// A hand-cranked turn: push events (or a failure) and the pump consumes them as they land, mirroring SteeringQueue's
// push/pull shape.
const crankedTurn = (): { turnFn: TurnStarter["stream"]; push: (event: AgentEvent) => void; fail: (error: Error) => void; close: () => void } => {
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

const turn = (conversationId: string): SentTurn & { conversationId: string } => ({ prompt: `do the thing`, conversationId, byPerson: true });

// The run a start made, for a case whose start must not be refused.
const started = (run: TurnRun | BeginRefusal): TurnRun => {
    if (typeof run === `string`) {
        throw new Error(`the start was refused: ${run}`);
    }
    return run;
};
const opening = () => [{ role: `user` as const, text: `do the thing`, sentAt: 1 }];

// Attach and drain: the head, then everything until the run finishes.
const collect = async (
    conversationId: string,
    conversations: typeof deps.conversations = deps.conversations,
): Promise<{ head: AttachHead; entries: AttachEntry[] }> => {
    const { head, entries } = turnRunOf(conversations, conversationId)!.attach(() => new Error(`fell behind`));
    const drained: AttachEntry[] = [];
    for await (const entry of entries) {
        drained.push(entry);
    }
    return { head, entries: drained };
};

describe(`turn runs`, () => {
    it(`opens with the turn's rows, streams changes to them and facts about it with 1-based seqs, and settles at the turn's end`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = started(startTurnRun(deps, turnFn, turn(`c-live`), { opening }));
        // Every row the run emits says which run it is, so a client redrawing it knows where it already sits.
        expect(run.rows).toEqual([{ role: `user`, text: `do the thing`, sentAt: 1, run: run.id }]);

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
            rows: [{ role: `user`, text: `do the thing`, sentAt: 1, run: run.id }],
        });
        expect(entries).toEqual([
            { kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `s1` } },
            { kind: `patch`, seq: 2, patch: { op: `append`, row: { role: `assistant`, text: ``, run: run.id } } },
            { kind: `patch`, seq: 3, patch: { op: `text`, index: 1, text: `a` } },
        ]);
        expect(run.done).toBe(true);
        expect(run.rows).toEqual([
            { role: `user`, text: `do the thing`, sentAt: 1, run: run.id },
            { role: `assistant`, text: `a`, run: run.id },
        ]);
    });

    it(`hands a late attach the rows so far and the facts, then only what follows`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = started(startTurnRun(deps, turnFn, turn(`c-replay`), { opening }));
        push({ kind: `session`, sessionId: `s1` });
        push({ kind: `delta`, text: `a` });
        push({ kind: `delta`, text: `b` });
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-replay`)!.rows[1]?.text).toBe(`ab`));

        const followed = collect(`c-replay`);
        push({ kind: `delta`, text: `c` });
        close();
        const { head, entries } = await followed;
        expect(head.seq).toBe(4);
        expect(head.rows).toEqual([
            { role: `user`, text: `do the thing`, sentAt: 1, run: run.id },
            { role: `assistant`, text: `ab`, run: run.id },
        ]);
        expect(entries).toEqual([
            { kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `s1` } },
            { kind: `patch`, seq: 5, patch: { op: `text`, index: 1, text: `c` } },
        ]);
    });

    it(`ends a follower that stopped reading, and only that one, with the error the attach named, while the run goes on`, async () => {
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(deps, turnFn, turn(`c-behind`), { opening });
        const stalled = turnRunOf(deps.conversations, `c-behind`)!.attach(() => new Error(`fell behind`));
        const reading = collect(`c-behind`);
        for (let index = 0; index <= MAX_BACKLOG_FRAMES; index += 1) {
            push({ kind: `delta`, text: `x` });
        }
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-behind`)!.rows[1]?.text).toHaveLength(MAX_BACKLOG_FRAMES + 1));
        expect(turnRunOf(deps.conversations, `c-behind`)!.done).toBe(false);
        close();
        // Everything reached the reader; the stalled one holds nothing past the cut, and learns why when it reads.
        expect((await reading).entries).toHaveLength(MAX_BACKLOG_FRAMES + 2);
        await expect(stalled.entries.next()).rejects.toThrow(`fell behind`);
    });

    it(`ends a follower when it is cut from outside, whatever it had queued`, async () => {
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(deps, turnFn, turn(`c-cut`), { opening });
        const followed = turnRunOf(deps.conversations, `c-cut`)!.attach(() => new Error(`fell behind`));
        push({ kind: `delta`, text: `a` });
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-cut`)!.rows[1]?.text).toBe(`a`));
        followed.cut(new Error(`authorization revoked`));
        await expect(followed.entries.next()).rejects.toThrow(`authorization revoked`);
        expect(turnRunOf(deps.conversations, `c-cut`)!.metrics().followers).toBe(0);
        close();
    });

    it(`serves several concurrent followers: each gets every change from its own head on`, async () => {
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(deps, turnFn, turn(`c-multi`), { opening });

        const first = collect(`c-multi`);
        push({ kind: `delta`, text: `a` });
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-multi`)!.rows).toHaveLength(2));
        const second = collect(`c-multi`);
        push({ kind: `delta`, text: `b` });
        close();

        expect((await first).entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        const late = await second;
        expect(late.head.rows[1]?.text).toBe(`a`);
        expect(late.entries.map((entry) => entry.seq)).toEqual([3]);
    });

    it(`lets a follower go when its connection aborts, while the run goes on`, async () => {
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(deps, turnFn, turn(`c-abort`), { opening });
        const connection = new AbortController();
        const { entries } = turnRunOf(deps.conversations, `c-abort`)!.attach(() => new Error(`fell behind`), connection.signal);
        push({ kind: `delta`, text: `a` });
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-abort`)!.rows).toHaveLength(2));
        connection.abort();
        const drained: AttachEntry[] = [];
        for await (const entry of entries) {
            drained.push(entry);
        }
        expect(drained.map((entry) => entry.seq)).toEqual([1, 2]);
        expect(turnRunOf(deps.conversations, `c-abort`)!.done).toBe(false);
        close();
    });

    it(`hands its raw frames to a listener from the moment it subscribes`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = started(startTurnRun(deps, turnFn, turn(`c-frames`)));
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
        const run = started(startTurnRun(deps, turnFn, turn(`c-wait`)));
        let settled = false;
        const waiting = run.waitUntilFinished().then(() => {
            settled = true;
        });

        push({ kind: `delta`, text: `still unwinding` });
        await waitFor(() => expect(run.rows).toHaveLength(1));
        expect(settled).toBe(false);

        close();
        await waiting;
        expect(settled).toBe(true);
    });

    it(`refuses a second start while the run is live, allows one after it settles`, async () => {
        const { turnFn, close } = crankedTurn();
        const first = started(startTurnRun(deps, turnFn, turn(`c-busy`)));
        expect(startTurnRun(deps, turnFn, turn(`c-busy`))).toBe(`busy`);

        close();
        await waitFor(() => expect(first.done).toBe(true));
        const { turnFn: nextTurnFn, close: closeNext } = crankedTurn();
        const second = started(startTurnRun(deps, nextTurnFn, turn(`c-busy`)));
        expect(second.id).not.toBe(first.id);
        expect(turnRunOf(deps.conversations, `c-busy`)!.id).toBe(second.id);
        closeNext();
    });

    it(`folds a thrown turn into a failure line and an abort into a stop`, async () => {
        const { turnFn, fail } = crankedTurn();
        startTurnRun(deps, turnFn, turn(`c-throw`), { opening });
        fail(new Error(`adapter exploded`));
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-throw`)!.done).toBe(true));
        expect(turnRunOf(deps.conversations, `c-throw`)!.rows.at(-1)).toEqual({
            role: `notice`,
            text: `adapter exploded`,
            run: turnRunOf(deps.conversations, `c-throw`)!.id,
        });
        expect((await collect(`c-throw`)).entries).toEqual([{ kind: `fact`, seq: 2, fact: { kind: `error`, message: `adapter exploded` } }]);

        const { turnFn: abortFn, fail: abort } = crankedTurn();
        startTurnRun(deps, abortFn, turn(`c-abort`), { opening });
        abort(new DOMException(`aborted`, `AbortError`) as unknown as Error);
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-abort`)!.done).toBe(true));
        expect(turnRunOf(deps.conversations, `c-abort`)!.rows.at(-1)).toEqual({
            role: `notice`,
            text: `Stopped.`,
            run: turnRunOf(deps.conversations, `c-abort`)!.id,
        });
        expect((await collect(`c-abort`)).entries).toEqual([]);
    });

    it(`freezes a card the stop caught pending, before the stop's own line`, async () => {
        const { turnFn, push, fail } = crankedTurn();
        startTurnRun(deps, turnFn, turn(`c-park-stop`), { opening });
        push({ kind: `question`, requestId: `q1`, questions: [] });
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-park-stop`)!.rows).toHaveLength(2));
        fail(new DOMException(`aborted`, `AbortError`) as unknown as Error);
        await waitFor(() => expect(turnRunOf(deps.conversations, `c-park-stop`)!.done).toBe(true));
        const parkStop = turnRunOf(deps.conversations, `c-park-stop`)!;
        expect(parkStop.rows.slice(1)).toEqual([
            { role: `assistant`, text: ``, question: { requestId: `q1`, questions: [], status: `cancelled` }, run: parkStop.id },
            { role: `notice`, text: `Stopped.`, run: parkStop.id },
        ]);
    });

    it(`takes a note the daemon writes, as a row every follower sees`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = started(startTurnRun(deps, turnFn, turn(`c-note`), { opening }));
        const followed = collect(`c-note`);
        push({ kind: `plan`, requestId: `p1`, text: `the plan` });
        await waitFor(() => expect(run.rows).toHaveLength(2));
        push({ kind: `resolved`, requestId: `p1`, reply: { kind: `plan`, requestId: `p1`, approve: true } });
        await waitFor(() => expect(run.rows[1]?.plan?.status).toBe(`approved`));
        run.note({ role: `notice`, text: `Plan approved.` });
        close();
        expect((await followed).entries.slice(-2)).toEqual([
            {
                kind: `patch`,
                seq: 3,
                patch: {
                    op: `replace`,
                    index: 1,
                    row: { role: `assistant`, text: ``, plan: { requestId: `p1`, text: `the plan`, status: `approved` }, run: run.id },
                },
            },
            { kind: `patch`, seq: 4, patch: { op: `append`, row: { role: `notice`, text: `Plan approved.`, run: run.id } } },
        ]);
    });

    it(`keeps one transcript per helper, out of the same frames`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const run = started(startTurnRun(deps, turnFn, turn(`c-child`), { opening }));
        push({ kind: `tool_call`, id: `task-1`, name: `Agent`, category: `other`, status: `in_progress` });
        push({ kind: `delta`, text: `child prose`, parentToolUseId: `task-1` });
        close();
        await waitFor(() => expect(run.done).toBe(true));
        expect(run.rowsOf(`task-1`)).toEqual([{ role: `assistant`, text: `child prose` }]);
        expect(run.rowsOf(`nobody`)).toEqual([]);
    });

    it(`drops a finished run after retention: attach then finds nothing`, async () => {
        jest.useFakeTimers();
        try {
            const { turnFn, close } = crankedTurn();
            startTurnRun(deps, turnFn, turn(`c-retain`));
            close();
            await waitFor(() => expect(turnRunOf(deps.conversations, `c-retain`)!.done).toBe(true));

            jest.advanceTimersByTime(45_000);
            expect(turnRunOf(deps.conversations, `c-retain`)).toEqual(expect.any(Object));
            jest.advanceTimersByTime(20_000);
            expect(turnRunOf(deps.conversations, `c-retain`)).toBeUndefined();
        } finally {
            jest.useRealTimers();
        }
    });

    it(`finishes transcript preparation before invoking the provider`, async () => {
        let release!: () => void;
        const before = new Promise<void>((resolve) => {
            release = resolve;
        });
        let invoked = false;
        const run = started(
            startTurnRun(
                deps,
                async function* () {
                    invoked = true;
                    yield { kind: `done` };
                },
                turn(`c-before`),
                { before },
            ),
        );

        await Promise.resolve();
        expect(invoked).toBe(false);
        release();
        await waitFor(() => expect(run.done).toBe(true));
        expect(invoked).toBe(true);
    });

    it(`hands the settled rows and the steered positions to the transcript sink`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const transcript = jest.fn(async () => true);
        const run = started(startTurnRun(deps, turnFn, turn(`c-sink`), { opening, transcript }));
        push({ kind: `delta`, text: `a` });
        push({ kind: `steer`, text: `and`, sentAt: 2 });
        close();
        await waitFor(() => expect(transcript).toHaveBeenCalledTimes(1));
        // The run rides into the record with its rows: a run stays attachable for a while after it settles, and a
        // window that redrew from the record has to recognise those rows when its head arrives.
        expect(transcript).toHaveBeenCalledWith(
            [
                { role: `user`, text: `do the thing`, sentAt: 1, run: run.id },
                { role: `assistant`, text: `a`, run: run.id },
                { role: `user`, text: `and`, sentAt: 2, run: run.id },
            ],
            [2],
        );
    });

    // A turn refused before it ran is not a turn: its message is back in the composer, so writing the pair down would
    // put those same words in the conversation once per press. Nothing at all reaches the record.
    it(`writes no record for a turn that was refused before it ran`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const transcript = jest.fn(async () => true);
        const run = started(startTurnRun(deps, turnFn, turn(`c-unrun`), { opening, transcript }));
        push({ kind: `error`, code: `sandbox-memory-low`, message: `Not enough sandbox memory to start this turn.` });
        close();

        await waitFor(() => expect(run.done).toBe(true));
        expect(transcript).not.toHaveBeenCalled();
        // The refusal still stands on the live run, so the press that failed says why; only the message is gone.
        expect(run.rows.map((row) => row.role)).toEqual([`notice`]);
    });

    // The bug this exists for: a fix press the sandbox started itself was turned away for memory, and its prompt went
    // with the refusal, because no composer anywhere held a copy to hand back. Whoever keeps the turn keeps the words.
    describe(`a turn turned away at the door that no sender keeps`, () => {
        const REFUSAL = { kind: `error`, code: `sandbox-memory-low`, message: `Sandbox memory is low.` } as const satisfies AgentEvent;

        it(`keeps its message, records it, and hands the turn over to be held`, async () => {
            const { turnFn, push, close } = crankedTurn();
            const transcript = jest.fn(async () => true);
            const held: { conversationId: string; run: string }[] = [];
            const run = started(
                startTurnRun(deps, turnFn, turn(`c-kept`), {
                    opening,
                    transcript,
                    holdTurnedAway: ({ input, run: refused }) => void held.push({ conversationId: input.conversationId, run: refused }),
                }),
            );
            const followed = collect(`c-kept`);
            push(REFUSAL);
            close();

            const { entries } = await followed;
            expect(held).toEqual([{ conversationId: `c-kept`, run: run.id }]);
            // Said on the fact itself, so an attached window knows the sandbox, not its composer, has the words.
            expect(entries).toContainEqual(expect.objectContaining({ kind: `fact`, fact: { ...REFUSAL, held: { ran: false } } }));
            await waitFor(() => expect(transcript).toHaveBeenCalledTimes(1));
            expect(run.rows).toEqual([
                { role: `user`, text: `do the thing`, sentAt: 1, run: run.id },
                expect.objectContaining({ role: `notice`, noticeAction: `sendAnyway`, sandboxHeld: true, run: run.id }),
            ]);

            // A refusal after the turn had spoken ended a turn that happened: there is nothing to hold for a press.
            const spoke = crankedTurn();
            const late = started(
                startTurnRun(deps, spoke.turnFn, turn(`c-spoke`), {
                    opening,
                    holdTurnedAway: ({ input }) => void held.push({ conversationId: input.conversationId, run: `` }),
                }),
            );
            spoke.push({ kind: `delta`, text: `on it` });
            spoke.push(REFUSAL);
            spoke.close();
            await waitFor(() => expect(late.done).toBe(true));
            expect(held.map((entry) => entry.conversationId)).toEqual([`c-kept`]);
        });
    });

    // A fleet whose journal rows are recorded as they are written, over the real store on an in-memory database, and
    // the turn body as streamAgent opens one: `begin` claims the conversation before any frame goes out.
    const journalledFleet = (putTurn: (entry: JournalledTurn) => void = () => undefined) => {
        const store = fleetStoreOver(openConversationsDb(IN_MEMORY));
        const writes: string[] = [];
        const entries: JournalledTurn[] = [];
        const fleet = memoryFleet({
            ...store,
            journal: {
                putTurn: (entry) => {
                    putTurn(entry);
                    store.journal.putTurn(entry);
                    entries.push(entry);
                    writes.push(entry.sessionId === undefined ? `record` : `record:${entry.sessionId}`);
                },
                deleteTurn: (conversationId) => {
                    store.journal.deleteTurn(conversationId);
                    writes.push(`clear:${conversationId}`);
                },
            },
        });
        const journalDeps = { conversations: fleet.conversations, events: createDomainEvents(() => {}) };
        const beginning = (body: TurnStarter["stream"]): TurnStarter["stream"] =>
            async function* (input, signal) {
                const conversationId = input.conversationId ?? ``;
                await fleet.conversations.send(conversationId, {
                    kind: `begin`,
                    turn: { conversationId, isolated: false, prompt: input.prompt, profile: {}, byPerson: input.byPerson },
                }).settled;
                yield* body(input, signal);
                await fleet.conversations.send(conversationId, { kind: `settle` }).settled;
            };
        return { store, writes, entries, journalDeps, beginning, conversations: fleet.conversations };
    };

    it(`journals the in-flight turn with the entry that opens it, folds in its session, and clears it last`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const { writes, journalDeps, beginning, conversations } = journalledFleet();
        startTurnRun(journalDeps, beginning(turnFn), turn(`c-journal`), { journalled: true });

        push({ kind: `session`, sessionId: `sess-7` });
        push({ kind: `done` });
        close();
        await waitFor(() => expect(turnRunOf(conversations, `c-journal`)!.done).toBe(true));

        await waitFor(() => expect(writes).toEqual([`record`, `record:sess-7`, `clear:c-journal`]));
    });

    it(`clears the entry for a FAILED turn too: only a turn nobody saw the end of deserves resuming`, async () => {
        const { turnFn, fail } = crankedTurn();
        const { writes, journalDeps, beginning, conversations } = journalledFleet();
        startTurnRun(journalDeps, beginning(turnFn), turn(`c-journal-fail`), { journalled: true });
        fail(new Error(`adapter exploded`));
        await waitFor(() => expect(turnRunOf(conversations, `c-journal-fail`)!.done).toBe(true));

        await waitFor(() => expect(writes).toEqual([`record`, `clear:c-journal-fail`]));
    });

    it(`does not clear the recovery journal until the transcript append has committed`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const { writes, journalDeps, beginning } = journalledFleet();
        let commit!: () => void;
        const transcript = jest.fn(
            () =>
                new Promise<boolean>((resolve) => {
                    commit = () => resolve(true);
                }),
        );
        startTurnRun(journalDeps, beginning(turnFn), turn(`c-transcript-commit`), { journalled: true, transcript });
        push({ kind: `done` });
        close();

        await waitFor(() => expect(transcript).toHaveBeenCalledTimes(1));
        expect(writes).toEqual([`record`]);
        commit();
        await waitFor(() => expect(writes).toEqual([`record`, `clear:c-transcript-commit`]));
    });

    it(`journals a raised card, keeps the session beside it, and takes the card back off when it resolves`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const { entries, journalDeps, beginning, conversations } = journalledFleet();
        startTurnRun(journalDeps, beginning(turnFn), turn(`c-parked`), { journalled: true });

        push({ kind: `session`, sessionId: `sess-3` });
        push({ kind: `plan`, requestId: `r-plan`, text: `the plan` });
        push({ kind: `question`, requestId: `r-q`, questions: [{ question: `which?`, header: `Pick`, multiSelect: false, options: [] }] });
        // Handover cards are never journalled: both die with the container, so there is nothing to restore them to.
        push({ kind: `browser_help`, requestId: `r-b`, session: `b-1`, account: `acc`, message: `captcha` });
        push({ kind: `terminal_help`, requestId: `r-t`, session: `agent-t1`, message: `type the one-time password` });
        push({ kind: `resolved`, requestId: `r-plan` });
        push({ kind: `done` });
        close();
        await waitFor(() => expect(turnRunOf(conversations, `c-parked`)!.done).toBe(true));

        const parked = entries.map((entry) => ({ session: entry.sessionId, cards: (entry.parked ?? []).map((card) => card.requestId) }));
        expect(parked).toEqual([
            { session: undefined, cards: [] }, // opening write, with the entry
            { session: `sess-3`, cards: [] },
            { session: `sess-3`, cards: [`r-plan`] },
            { session: `sess-3`, cards: [`r-plan`, `r-q`] },
            { session: `sess-3`, cards: [`r-q`] }, // the plan resolved; the question still stands
        ]);
    });

    it(`a journal rewrite that throws cannot break the turn`, async () => {
        const { turnFn, push, close } = crankedTurn();
        const { journalDeps, beginning } = journalledFleet((entry) => {
            if (entry.sessionId !== undefined) {
                throw new Error(`disk full`);
            }
        });
        startTurnRun(journalDeps, beginning(turnFn), turn(`c-journal-broken`), { journalled: true });

        const followed = collect(`c-journal-broken`, journalDeps.conversations);
        push({ kind: `session`, sessionId: `sess-9` });
        push({ kind: `done` });
        close();
        expect((await followed).entries).toEqual([{ kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `sess-9` } }]);
    });

    it(`a turn that never began writes no journal row, and leaves none held for the next begin`, async () => {
        const { turnFn, close } = crankedTurn();
        const { writes, journalDeps, conversations } = journalledFleet();
        startTurnRun(journalDeps, turnFn, turn(`c-never`), { journalled: true });
        close();
        await waitFor(() => expect(turnRunOf(conversations, `c-never`)!.done).toBe(true));

        await conversations.send(`c-never`, { kind: `begin`, turn: { conversationId: `c-never`, isolated: false, prompt: `later`, profile: {}, byPerson: true } })
            .settled;
        expect(writes).toEqual([]);
    });

    it(`caches each provider's published commands so a conversation that hasn't run a turn can read them`, async () => {
        resetCommands();
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(deps, turnFn, { ...turn(`c-commands`), agent: `kimi` });

        const followed = collect(`c-commands`);
        push({ kind: `commands`, items: [{ name: `review`, description: `Review a PR` }] });
        // Later commands list replaces the earlier one wholesale.
        push({ kind: `commands`, items: [{ name: `deploy`, description: `Ship it` }] });
        push({ kind: `done` });
        close();
        await followed;

        expect(commandsOf(`kimi`)).toEqual([{ name: `deploy`, description: `Ship it` }]);
        // Keyed by provider; an absent `agent` means claude.
        expect(commandsOf(`claude`)).toEqual([]);
    });
});

describe(`a run on an archived conversation`, () => {
    // Only a person reopens one, so a run nobody sent is refused before it exists: no row, record or transcript is left.
    it(`is refused before it exists when nobody sent it, and starts when a person did`, async () => {
        const fleet = memoryFleet();
        const filedDeps = { conversations: fleet.conversations, events: createDomainEvents(() => {}) };
        await beginTurn(fleet.conversations, { conversationId: `c-filed`, isolated: false, prompt: `go`, profile: {}, byPerson: true }, 1_000);
        await fleet.conversations.send(`c-filed`, { kind: `settle` }, 2_000).settled;
        await fleet.agents.setArchived([`c-filed`], 3_000);
        const transcript = jest.fn(async () => true);
        let invoked = 0;
        const body: TurnStarter["stream"] = async function* () {
            invoked += 1;
            yield { kind: `done` };
        };

        expect(startTurnRun(filedDeps, body, { ...turn(`c-filed`), byPerson: false }, { opening, transcript })).toBe(`archived`);
        expect(turnRunOf(fleet.conversations, `c-filed`)).toBeUndefined();

        const run = started(startTurnRun(filedDeps, body, turn(`c-filed`), { opening, transcript }));
        await waitFor(() => expect(run.done).toBe(true));
        expect(invoked).toBe(1);
        expect(transcript).toHaveBeenCalledTimes(1);
    });
});

describe(`the settle notice`, () => {
    it(`carries the turn's actor, its failure and its last words`, async () => {
        const heard: DomainEventMap["run.settled"][] = [];
        const stop = deps.events.subscribe("run.settled", (settled) => heard.push(settled));
        const { turnFn, push, close } = crankedTurn();
        startTurnRun(deps, turnFn, { ...turn(`c-settle`), actor: `agent:parent-1` }, { opening });
        push({ kind: `delta`, text: `first thought` });
        push({ kind: `text_end` });
        push({ kind: `delta`, text: `Ported all 12 tests.` });
        push({ kind: `error`, message: `usage limit reached` });
        close();
        await waitFor(() => expect(heard).toHaveLength(1));
        stop();
        expect(heard[0]).toEqual({
            conversationId: `c-settle`,
            actor: `agent:parent-1`,
            failure: `usage limit reached`,
            closing: `Ported all 12 tests.`,
        });
    });
});
