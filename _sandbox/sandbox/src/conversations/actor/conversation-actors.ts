import { keyedLock } from "@intentic/base/async";
import type { ActiveTurn } from "../../agent/checkpoints/agent-steering.js";
import type { JournalledTurn } from "../../agent/run/turn/turn-journal.js";
import { recordConversationPrompt, recordPrompt } from "../../sessions/transcript-search.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { type BeginTurn, type ConversationEffect, type ConversationEvent, decide, refusesArchived, type ReplyOf, type SettleFlush } from "./conversation-decide.js";
import { createHoldingsIndex, type Holding, type Holdings, type Share } from "./conversation-holdings.js";
import { NO_QUEUE, type TurnQueue } from "./conversation-queue.js";
import { type ConversationState, type HeldRecord, idleConversation, writing } from "./conversation-state.js";

// One actor per conversation, each holding the conversation's state and applying events to it through `decide`, the
// only writer: an event is applied whole, synchronously, before any effect it named runs, so a claim is one atomic step
// and an effect that sends to the same conversation meets the state its own event left. The runner here performs the
// effects; the registry's books are the entries it writes through.

// The registry's half an actor writes through: the persisted entries, the roster broadcast, and the land probes.
export interface ConversationBooks {
    readonly entry: (id: string) => PersistedAgent | undefined;
    // The turn's entry, and the run's journal row with it when one was filed; the next `persist` writes both as one.
    readonly open: (turn: BeginTurn, now: number, inFlight: JournalledTurn | undefined) => void;
    readonly settle: (id: string, flush: SettleFlush, now: number) => void;
    readonly abandon: (id: string, failure: string | undefined, now: number) => void;
    readonly bindSession: (id: string, sessionId: string, account: string | undefined) => void;
    readonly dropSession: (id: string) => void;
    readonly planTitle: (id: string, text: string) => void;
    readonly compacted: (id: string) => void;
    // The begun run's journal row, rewritten or deleted on its own.
    readonly journal: (id: string, entry: JournalledTurn) => Promise<void>;
    readonly unjournal: (id: string) => Promise<void>;
    readonly persist: () => Promise<void>;
    readonly reprobe: () => Promise<unknown>;
    readonly broadcast: () => void;
    // A broadcast a running turn's progress raises: it may ride the next send, a moment later, with the rest of a burst.
    readonly progress: () => void;
    // Forgets the entries and every projection cache kept beside them; the actors' own half goes first, in dispose.
    readonly remove: (ids: readonly string[]) => Promise<void>;
    // The queue onto the conversation's entry, for the next `persist` to write; nothing for one with no entry yet.
    readonly queue: (id: string, queue: TurnQueue) => void;
}

// A sent event's answer at once, and again once the effects that outlive the send (a write, a probe) have run, for a
// caller that must wait for them.
export interface Delivered<R> {
    readonly reply: R;
    readonly settled: Promise<R>;
}

export interface ConversationActors {
    readonly send: <E extends ConversationEvent>(conversationId: string, event: E, now?: number) => Delivered<ReplyOf<E>>;
    // The actor's state, or undefined for a conversation this daemon has not heard from.
    readonly state: (conversationId: string) => ConversationState | undefined;
    // What waits for the conversation's next turn, read back from its entry by the first ask after a restart.
    readonly queued: (conversationId: string) => TurnQueue;
    readonly running: (conversationId: string) => boolean;
    // Whether a turn would be refused as archived (refusesArchived), asked before a run is made for it.
    readonly archived: (conversationId: string) => boolean;
    // Narrower than `running`: a park or a chosen ending already counts as quiet enough to rebase under.
    readonly writing: (conversationId: string) => boolean;
    // Whether a land lease is shown right now; what a second land press is refused against.
    readonly landing: (conversationId: string) => boolean;
    // The live turn's session ahead of the settle that writes it, else the entry's.
    readonly sessionIdOf: (conversationId: string) => string | undefined;
    // Sessions of the turns running right now, the terminals list's "still working" signal.
    readonly liveSessionIds: () => string[];
    // Turns in flight per runner, derived rather than counted, so it cannot drift from a forgotten decrement.
    readonly inFlightByRunner: () => Map<string, number>;
    // One land at a time per conversation, later ones queued in arrival order; claimed synchronously, released once the
    // last queued one settles, whether or not it threw.
    readonly withLandLease: <T>(conversationId: string, fn: () => Promise<T>) => Promise<T>;
    // Holds the conversation against its own turns while a rewind restores files; refused (undefined) under a live turn.
    readonly withRewindLease: <T>(conversationId: string, fn: () => Promise<T>) => Promise<T | undefined>;
    // Lends the conversation's live turn its hard-cancel and steering seam; last-wins, and the unregister it returns is
    // bound to this turn, so a stale one can't clobber its successor. The turn starts unwatched.
    readonly registerTurn: (conversationId: string, turn: ActiveTurn) => () => void;
    // Words into the live turn's steering queue; false when no turn with one is live.
    readonly steer: (conversationId: string, text: string) => boolean;
    // Hard-cancels the live turn; false when nothing is registered.
    readonly abort: (conversationId: string) => boolean;
    // Turns registered right now; a machine mid-turn is never idle.
    readonly activeTurnCount: () => number;
    readonly turnActive: (conversationId: string) => boolean;
    // Every held turn, first recorded first (a re-record keeps its place); a snapshot, since the pass moves what it reads.
    readonly stranded: () => readonly Stranded[];
    // One kind of what conversations hold beside their state, each conversation's share on its actor.
    readonly holdings: <V>(kind: Holding<V>) => Holdings<V>;
    // What still holds anything of this conversation's, by name: its actor, a stranded record, a holding's item held by
    // it or about it. Empty once it is gone.
    readonly traces: (conversationId: string) => readonly string[];
    // Every piece of these conversations' in-memory state, then their entries: the one way a conversation leaves.
    readonly dispose: (conversationIds: readonly string[]) => Promise<void>;
}

export interface Stranded {
    readonly conversationId: string;
    readonly record: HeldRecord;
}

interface Actor {
    state: ConversationState;
    // The live turn's hard-cancel and steering queue; transport, not state, since a callback is not a value.
    activeTurn: ActiveTurn | undefined;
    // Its share of every holding: records their owning module patches in place, waiters and timers, none of them values
    // `decide` could own.
    readonly held: Share;
}

// An effect is either done when it returns or leaves a promise; everything after an async one waits for it.
type Performed = void | Promise<unknown>;

type Performer<K extends ConversationEffect["kind"]> = (id: string, effect: Extract<ConversationEffect, { kind: K }>, now: number) => Performed;

// Where each effect lands: the books for the entries and the roster, the transcript index for the prompt.
const effectsOn = (books: ConversationBooks): { readonly [K in ConversationEffect["kind"]]: Performer<K> } => ({
    broadcast: () => books.broadcast(),
    progress: () => books.progress(),
    persist: () => books.persist(),
    reprobe: () => books.reprobe(),
    "entry-opened": (_id, effect, now) => books.open(effect.turn, now, effect.inFlight),
    "journal-written": (id, effect) => books.journal(id, effect.entry),
    "journal-cleared": (id) => books.unjournal(id),
    "entry-settled": (id, effect, now) => books.settle(id, effect.flush, now),
    "entry-abandoned": (id, effect, now) => books.abandon(id, effect.failure, now),
    "session-bound": (id, effect) => books.bindSession(id, effect.sessionId, effect.account),
    "session-dropped": (id) => books.dropSession(id),
    "title-planned": (id, effect) => books.planTitle(id, effect.text),
    compacted: (id) => books.compacted(id),
    "session-prompt": (_id, effect) => recordPrompt(effect.sessionId, effect.prompt),
    "conversation-prompt": (id, effect) => recordConversationPrompt(id, effect.prompt),
    "queue-written": (id, effect) => books.queue(id, effect.queue),
});

// Whether a turn on the conversation would be refused as archived, read off the same entry `begin` reads.
const archivedIn =
    (books: Pick<ConversationBooks, "entry">) =>
    (id: string): boolean =>
        refusesArchived(books.entry(id));

export const createConversationActors = (books: ConversationBooks): ConversationActors => {
    const actors = new Map<string, Actor>();
    // Lands queued per conversation, each behind the last however it ended.
    const landChain = keyedLock<string>();
    // Conversations holding a turn, in first-recorded order, so the resume pass meets them oldest first.
    const strandedOrder = new Set<string>();
    const indexStranded = (id: string, state: ConversationState): void => {
        if (state.resume.held === undefined) {
            strandedOrder.delete(id);
        } else {
            strandedOrder.add(id);
        }
    };

    const actorOf = (id: string): Actor => {
        const existing = actors.get(id);
        if (existing !== undefined) {
            return existing;
        }
        const fresh: Actor = { state: idleConversation(books.entry(id)?.queue), activeTurn: undefined, held: new Map() };
        actors.set(id, fresh);
        return fresh;
    };
    const holdings = createHoldingsIndex((holder, create) => (create ? actorOf(holder) : actors.get(holder))?.held);

    const performers = effectsOn(books);
    const perform = (id: string, effect: ConversationEffect, now: number): Performed =>
        (performers[effect.kind] as Performer<ConversationEffect["kind"]>)(id, effect, now);

    // In order: each effect runs at once until one returns a promise, and every later one runs after it settles.
    const run = (id: string, effects: readonly ConversationEffect[], now: number): Promise<void> => {
        let tail: Promise<unknown> | undefined;
        for (const effect of effects) {
            if (tail === undefined) {
                const performed = perform(id, effect, now);
                tail = performed instanceof Promise ? performed : undefined;
            } else {
                tail = tail.then(() => perform(id, effect, now));
            }
        }
        return tail === undefined ? Promise.resolve() : tail.then(() => undefined);
    };

    const send = <E extends ConversationEvent>(id: string, event: E, now: number = Date.now()): Delivered<ReplyOf<E>> => {
        const actor = actorOf(id);
        const decision = decide(actor.state, event, now, books.entry(id));
        actor.state = decision.state;
        indexStranded(id, decision.state);
        return { reply: decision.reply, settled: run(id, decision.effects, now).then(() => decision.reply) };
    };

    const running = (id: string): boolean => actors.get(id)?.state.phase.kind === "running";

    const sessionIdOf = (id: string): string | undefined => actors.get(id)?.state.turn.sessionId ?? books.entry(id)?.sessionId;

    return {
        send,
        state: (id) => actors.get(id)?.state,
        // An actor is made only for a conversation whose entry kept something waiting: asking must not leave a trace.
        queued: (id) => {
            const stored = books.entry(id)?.queue;
            return (
                actors.get(id)?.state.queue ?? (stored === undefined || stored.items.length === 0 ? (stored ?? NO_QUEUE) : actorOf(id).state.queue)
            );
        },
        running,
        archived: archivedIn(books),
        writing: (id) => {
            const actor = actors.get(id);
            return actor !== undefined && writing(actor.state);
        },
        landing: (id) => actors.get(id)?.state.turn.landing === true,
        sessionIdOf,
        liveSessionIds: () =>
            [...actors.keys()].filter(running).flatMap((id) => {
                const sessionId = sessionIdOf(id);
                return sessionId === undefined ? [] : [sessionId];
            }),
        inFlightByRunner: () => {
            const counts = new Map<string, number>();
            for (const id of [...actors.keys()].filter(running)) {
                const placement = books.entry(id)?.placement;
                const runner = placement?.kind === "worktree" ? placement.runner : undefined;
                if (runner !== undefined) {
                    counts.set(runner, (counts.get(runner) ?? 0) + 1);
                }
            }
            return counts;
        },
        withLandLease: async (id, fn) => {
            send(id, { kind: "land-leased" });
            try {
                return await landChain(id, fn);
            } finally {
                send(id, { kind: "land-released" });
            }
        },
        withRewindLease: async (id, fn) => {
            if (!send(id, { kind: "rewind-leased" }).reply) {
                return undefined;
            }
            try {
                return await fn();
            } finally {
                send(id, { kind: "rewind-released" });
            }
        },
        registerTurn: (id, turn) => {
            send(id, { kind: "turn-registered" });
            actorOf(id).activeTurn = turn;
            return () => {
                const actor = actors.get(id);
                if (actor?.activeTurn === turn) {
                    actor.activeTurn = undefined;
                }
            };
        },
        steer: (id, text) => actors.get(id)?.activeTurn?.steering?.push(text) ?? false,
        abort: (id) => {
            const turn = actors.get(id)?.activeTurn;
            turn?.abort();
            return turn !== undefined;
        },
        activeTurnCount: () => [...actors.values()].filter((actor) => actor.activeTurn !== undefined).length,
        turnActive: (id) => actors.get(id)?.activeTurn !== undefined,
        stranded: () =>
            [...strandedOrder].flatMap((conversationId) => {
                const record = actors.get(conversationId)?.state.resume.held;
                return record === undefined ? [] : [{ conversationId, record }];
            }),
        holdings: holdings.holdings,
        traces: (id) => [...(actors.has(id) ? ["actor"] : []), ...(strandedOrder.has(id) ? ["stranded"] : []), ...holdings.traces(id)],
        dispose: async (ids) => {
            const owed = holdings.release(new Set(ids));
            for (const id of ids) {
                actors.delete(id);
                strandedOrder.delete(id);
            }
            // Only once the actors are gone, so an owner letting go of an item meets none of them.
            for (const drop of owed) {
                drop();
            }
            await books.remove(ids);
        },
    };
};
