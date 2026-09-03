import {
    type AgentEvent,
    type AgentTurn,
    type AttachFrame,
    isTurnFact,
    type ParkedCard,
    type TranscriptPatch,
    type TranscriptRow,
    type TurnFact,
} from "@intentic/sandbox-contract";
import { TranscriptFold, type TurnEnding } from "@intentic/sandbox-contract/transcript-fold";
import { recordCommands } from "./agent-commands.js";
import type { TurnJournal } from "./turn-journal.js";

/* Detached turn runs, turn EXECUTION decoupled from any client connection. POST /agent starts a run: the
 * turn generator is pumped daemon-side into the run's TRANSCRIPT, folded frame by frame as it arrives
 * (sandbox-contract's transcript-fold.ts), and any number of clients render it by attaching: the rows so far
 * on the head, then every change as it lands. The initiating window holds no special stream, a reload, a
 * second window, or another device attaches the same way, which is what makes a turn survive all of them.
 *
 * The run holds ROWS, not frames. What a frame means for the transcript is decided here, once, at the moment
 * it arrives, and the same rows are what the record keeps when the turn settles: a reopened chat shows what
 * every window saw because it is showing the same thing. The raw frames are handed on to whoever asked for
 * them (a child's supervisor, a loop, `frames()`) and kept nowhere, which is also what stopped a long turn's
 * log climbing towards a gigabyte: a Codex command's output arrived as whole snapshots, one per frame, and every
 * one of them was retained.
 *
 * A finished run is retained briefly so a client that lost its stream near the end still finds it; after that
 * the transcript record is the copy and attach reports NOT_FOUND. Keyed by conversationId, the daemon is
 * single-tenant behind its authenticated tunnel (same bet as agent-steering). Two things leave this pump: the
 * TURN, one journal entry naming what to run again while it is in flight (turn-journal.ts), and the
 * TRANSCRIPT, the rows it produced, once it is whole. */

// The turn generator a run pumps, streamAgent's shape, injected to keep this module cycle-free of
// agent.routes (and swappable in tests).
export type TurnFn = (input: AgentTurn, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

// The two moments in a turn's life where the operator might want to be told, reported to whoever started the
// run. Deliberately narrow and copy-free: this module knows WHEN a turn parks or settles, and nothing about
// how that should read on a lock screen, agent.routes owns the wording (and the decision to send at all).
// Both are fire-and-forget; an observer that throws must never affect the turn, so the pump guards them.
export interface TurnObserver {
    // The agent has stopped and is waiting for the user: a plan to approve, a question to answer, a tool
    // permission to grant, or one of its two handovers, a browser stuck on something only a person can clear,
    // a terminal parked at a prompt only a person can answer. May fire several times in one turn.
    readonly awaiting: (kind: "plan" | "question" | "permission" | "browser_help" | "terminal_help") => void;
    // The run reached its end, exactly once. `error` is set only for a genuine failure, an abort via
    // /agent/stop settles as a clean "done", because the user who pressed stop knows how it ended.
    readonly settled: (outcome: { readonly ok: boolean; readonly error?: string }) => void;
}

// A reconnect retries within seconds; one minute covers the reconnect ladder with ample margin.
const RETAIN_MS = 60_000;

// One entry of the attach stream past its head, what a follower is handed in order: a change to the rows, or
// a fact about the turn.
export type AttachEntry = Extract<AttachFrame, { kind: "patch" | "fact" }>;
export type AttachHead = Extract<AttachFrame, { kind: "attached" }>;

/* One subscriber's queue. Each follower holds only what it has not yet read, so a reader that keeps up holds
 * nothing and a stalled one holds its own backlog and nobody else's; the run itself keeps no log at all. */
class Mailbox<T> {
    private readonly items: T[];
    private wake: (() => void) | undefined;
    private closed = false;

    constructor(replay: readonly T[] = []) {
        this.items = [...replay];
    }

    push(item: T): void {
        this.items.push(item);
        this.wake?.();
    }

    close(): void {
        this.closed = true;
        this.wake?.();
    }

    // Everything pushed, in order, until closed and drained. `released` runs however the reader leaves,
    // including a consumer that stops iterating, which is the one exit that would otherwise leak the queue.
    async *drain(released: () => void): AsyncGenerator<T> {
        try {
            for (;;) {
                while (this.items.length > 0) {
                    yield this.items.shift()!;
                }
                if (this.closed) {
                    return;
                }
                await new Promise<void>((resolve) => {
                    this.wake = resolve;
                });
                this.wake = undefined;
            }
        } finally {
            released();
        }
    }
}

export class TurnRun {
    readonly id = crypto.randomUUID();
    private finishedAt: number | undefined;
    private readonly fold: TranscriptFold;
    /* THE HELPERS' OWN TRANSCRIPTS, one fold per subagent, tagged with the call that spawned it, folded from the
     * same frames as they pass: a child's frames are already in the parent's stream, tagged, so the Subagents
     * area reads a child's transcript as a projection of its parent's turn, nothing streamed separately and
     * nothing stored twice. Every child fold sees every frame and keeps what carries its tag. */
    private readonly children = new Map<string, TranscriptFold>();
    // The facts so far, replayed to every attach: a window joining late still has to learn which session the
    // turn runs and where its branch stands. Small by construction: a handful per turn.
    private readonly facts: AttachEntry[] = [];
    private seq = 0;
    private readonly followers = new Set<Mailbox<AttachEntry>>();
    private readonly listeners = new Set<Mailbox<AgentEvent>>();
    private waiters: (() => void)[] = [];

    constructor(
        // What the turn opens with: the user's message, or the notice standing in for a repeated one.
        opening: readonly TranscriptRow[],
        readonly startedAt = Date.now(),
    ) {
        this.fold = new TranscriptFold(opening);
    }

    get done(): boolean {
        return this.finishedAt !== undefined;
    }

    // True once the run is finished AND past retention, attach then reports NOT_FOUND and the map entry drops.
    expired(now: number): boolean {
        return this.finishedAt !== undefined && now - this.finishedAt > RETAIN_MS;
    }

    // The turn's transcript as it stands: what the record keeps once the turn is whole, and what a reopened tab
    // draws meanwhile. Live, so read it, never hold it.
    get rows(): readonly TranscriptRow[] {
        return this.fold.rows;
    }

    // Where the user's mid-turn messages landed, by row, for the anchors filed under them at settlement.
    get steerRows(): readonly number[] {
        return this.fold.steerRows;
    }

    // One helper's transcript, by the id of the call that spawned it. Empty for a call that spawned nothing
    // this run has heard from.
    rowsOf(tag: string): readonly TranscriptRow[] {
        return this.children.get(tag)?.rows ?? [];
    }

    metrics(): { readonly rows: number; readonly followers: number } {
        return { rows: this.fold.rows.length, followers: this.followers.size };
    }

    push(event: AgentEvent): void {
        const patches = this.fold.apply(event);
        const parent = "parentToolUseId" in event ? event.parentToolUseId : undefined;
        if (parent !== undefined && !this.children.has(parent)) {
            this.children.set(parent, new TranscriptFold([], parent));
        }
        for (const child of this.children.values()) {
            child.apply(event);
        }
        this.publish(patches, isTurnFact(event) ? event : undefined);
        for (const listener of this.listeners) {
            listener.push(event);
        }
    }

    // A row the daemon writes on the turn's behalf (a decision's notice, the feedback that answered a card).
    note(row: TranscriptRow): void {
        this.publish(this.fold.note(row));
    }

    finish(ending: TurnEnding = "settled"): void {
        this.publish(this.fold.finish(ending));
        this.finishedAt = Date.now();
        for (const follower of this.followers) {
            follower.close();
        }
        for (const listener of this.listeners) {
            listener.close();
        }
        this.wake();
    }

    // Resolve only once the detached pump has completely unwound. Stop uses this as its acknowledgement
    // boundary: aborting the provider is not enough, because a successor cannot start until the old generator's
    // finally blocks have released the conversation registry and worktree ownership too.
    async waitUntilFinished(): Promise<void> {
        while (!this.done) {
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }
    }

    /* Attach: the rows so far and the facts so far on the head, then everything that lands from this instant,
     * until the run finishes. The head and the subscription are taken in one synchronous step, so nothing can
     * land between the snapshot and the first live entry, and nothing in the snapshot is delivered again. */
    attach(): { readonly head: AttachHead; readonly entries: AsyncGenerator<AttachEntry> } {
        const mailbox = new Mailbox<AttachEntry>(this.facts);
        const head: AttachHead = { kind: "attached", run: this.id, startedAt: this.startedAt, seq: this.seq, rows: structuredClone(this.fold.rows) };
        if (this.done) {
            mailbox.close();
        } else {
            this.followers.add(mailbox);
        }
        return { head, entries: mailbox.drain(() => this.followers.delete(mailbox)) };
    }

    // The raw frames from this instant on, for the daemon's own readers of a turn (a child's supervisor, a loop),
    // which want what the provider said rather than what the transcript made of it. Nothing before now: the
    // pump starts on the next tick, so a reader that subscribes as it starts the run misses nothing.
    frames(): AsyncGenerator<AgentEvent> {
        const mailbox = new Mailbox<AgentEvent>();
        if (this.done) {
            mailbox.close();
        } else {
            this.listeners.add(mailbox);
        }
        return mailbox.drain(() => this.listeners.delete(mailbox));
    }

    private publish(patches: readonly TranscriptPatch[], fact?: TurnFact): void {
        for (const patch of patches) {
            this.deliver({ kind: "patch", seq: ++this.seq, patch });
        }
        if (fact !== undefined) {
            const entry: AttachEntry = { kind: "fact", seq: ++this.seq, fact };
            this.facts.push(entry);
            this.deliver(entry);
        }
    }

    private deliver(entry: AttachEntry): void {
        for (const follower of this.followers) {
            follower.push(entry);
        }
    }

    private wake(): void {
        const waiting = this.waiters;
        this.waiters = [];
        for (const resolve of waiting) {
            resolve();
        }
    }
}

const runs = new Map<string, TurnRun>();

/* The module-level settle event, beside the per-run observer rather than inside it: the observer is the run
 * STARTER's channel (notifications, wording), while this is for machinery that cares about every run however it
 * was started, the resource reaper seeds its stop clock here. Guarded like `tell`: a listener that throws must
 * never reach a turn that is otherwise finished. */
const settleListeners = new Set<(conversationId: string) => void>();
export const onTurnSettled = (listener: (conversationId: string) => void): (() => void) => {
    settleListeners.add(listener);
    return () => settleListeners.delete(listener);
};

const notifySettled = (conversationId: string): void => {
    for (const listener of settleListeners) {
        try {
            listener(conversationId);
        } catch {
            // Nothing to do and nowhere to report it: the turn is the thing that matters.
        }
    }
};

const sweep = (): void => {
    const now = Date.now();
    for (const [conversationId, run] of runs) {
        if (run.expired(now)) {
            runs.delete(conversationId);
        }
    }
};

// Everything a run needs beyond the turn itself, all of it optional because every one of them is a side-channel
// the turn must be able to run without.
export interface RunOptions {
    readonly observer?: TurnObserver;
    // Where the in-flight turn is written down so a daemon death doesn't take it with it. Injected like TurnFn,
    // for the same reason: this module stays free of the composition (and swappable in tests).
    readonly journal?: TurnJournal;
    // What the turn's transcript OPENS with, given the instant the run started: the user's message as a row,
    // built by whoever holds the prompt and knows what the daemon layered onto it (sessions/turn-transcript.ts).
    readonly opening?: (startedAt: number) => readonly TranscriptRow[];
    // Where the SETTLED turn is written down, the conversation's durable transcript, the copy every provider
    // gets whether or not it keeps a session store of its own (sessions/transcript-record.ts). Handed the rows
    // the run folded and where the user's mid-turn messages sit among them.
    readonly transcript?: (rows: readonly TranscriptRow[], steerRows: readonly number[]) => Promise<unknown>;
    // Side-channel preparation that must precede the provider (a fork's record being copied). A caller passes a
    // guarded promise: its failure may cost persistence, never the turn itself.
    readonly before?: Promise<unknown>;
    // How many boots have already re-run this turn, carried through so a resume that dies again is not resumed
    // a third time (see turn-resume's boot pass). A first-hand turn starts at 0.
    readonly attempts?: number;
}

// Start a detached run for the conversation's turn, or undefined when one is already live (the route 409s,
// the client serializes its own turns, so a live run means another window/device is mid-turn). The pump owns
// the generator: a thrown turn is folded into the transcript as an error (an abort, /agent/stop, as a stop),
// so followers always see the run settle.
export function startTurnRun(
    turnFn: TurnFn,
    input: AgentTurn & { conversationId: string },
    { observer, journal, opening, transcript, before, attempts = 0 }: RunOptions = {},
): TurnRun | undefined {
    sweep();
    const existing = runs.get(input.conversationId);
    if (existing !== undefined && !existing.done) {
        return undefined;
    }
    const startedAt = Date.now();
    const run = new TurnRun(opening?.(startedAt) ?? [], startedAt);
    runs.set(input.conversationId, run);
    const provider = input.agent ?? "claude";
    /* THE JOURNAL ENTRY, opened here, updated when the session is known, closed in the pump's finally.
     *
     * Every one of those is queued behind the previous one rather than fired at the disk independently. None of
     * them may block the caller (the route acks the run id synchronously), but they must not overtake each other
     * either: a clear that raced the opening write would delete a file that does not exist yet, and one that
     * raced the session-frame update would be followed by that update RE-CREATING the entry, leaving behind, in
     * both cases, a journal entry for a turn that has already finished. Which the next boot would dutifully
     * resume. Serializing costs nothing here (at most three writes in a whole turn) and removes the entire class.
     *
     * A journal write that fails changes nothing else: the turn is the thing that matters, and the cost is one
     * turn that will not come back from a restart. */
    let journalled: Promise<unknown> = Promise.resolve();
    const journalOp = (op: (target: TurnJournal) => Promise<void>): void => {
        if (journal === undefined) {
            return;
        }
        journalled = journalled.then(() => op(journal)).catch(() => undefined);
    };
    /* The journal entry's live fields, held so every rewrite carries ALL of them, the session update and a
     * park update writing only what each knew would erase the other's half. `parked` is the cards the turn is
     * waiting on right now, written down because a daemon death under a park must restore the card, not the
     * turn (turn-resume.ts), and the card's content exists nowhere else once the run dies with the process.
     * The entry is SNAPSHOTTED synchronously, only the write is queued; a closure that read these fields when
     * it finally ran would journal a later frame's state under this one's write. */
    let sessionId: string | undefined;
    const parked: ParkedCard[] = [];
    const journalEntry = (): void => {
        const entry = {
            kind: "turn" as const,
            turn: input,
            startedAt: run.startedAt,
            attempts,
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(parked.length > 0 ? { parked: [...parked] } : {}),
        };
        journalOp((target) => target.recordTurn(entry));
    };
    journalEntry();
    // An observer is an optional side-channel, so it must be unable to break the turn, a throw from a
    // notification hook cannot be allowed to abort a run that is otherwise fine.
    const tell = (report: (target: TurnObserver) => void): void => {
        if (observer === undefined) {
            return;
        }
        try {
            report(observer);
        } catch {
            // Nothing to do and nowhere to report it: the turn is the thing that matters.
        }
    };
    void (async () => {
        // Set by the error frame below (or by a provider emitting one mid-stream), read once at settle.
        let failure: string | undefined;
        let stopped = false;
        try {
            await before;
            for await (const event of turnFn(input, undefined)) {
                // Every provider republishes its slash commands each turn; cache the latest so a conversation
                // that hasn't run one yet still has a populated `/` popover (see agent-commands.ts).
                if (event.kind === "commands") {
                    recordCommands(provider, event.items);
                }
                // The frames that park the turn on the user. They keep the run's fetch open, so from the
                // outside it still looks "live", which is exactly why they need their own signal.
                if (
                    event.kind === "plan" ||
                    event.kind === "question" ||
                    event.kind === "permission" ||
                    event.kind === "browser_help" ||
                    event.kind === "terminal_help"
                ) {
                    tell((target) => target.awaiting(event.kind));
                }
                // The restorable cards ride the journal entry while they are up (the two handover cards stay
                // out, see ParkedCardSchema), and come off it as each resolves: what is in the entry at any
                // instant is exactly what a boot would have to restore.
                if (event.kind === "plan" || event.kind === "question" || event.kind === "permission") {
                    parked.push(event);
                    journalEntry();
                }
                if (event.kind === "resolved") {
                    const held = parked.findIndex((card) => card.requestId === event.requestId);
                    if (held !== -1) {
                        parked.splice(held, 1);
                        journalEntry();
                    }
                }
                // The session the provider minted or advanced for this turn, folded into the journal entry as
                // soon as it is known. It is what makes a resume CONTINUE, the partial work of the interrupted
                // turn lives in that session, and a resume without it re-runs the whole turn from nothing.
                if (event.kind === "session") {
                    sessionId = event.sessionId;
                    journalEntry();
                }
                if (event.kind === "error") {
                    failure = event.message;
                }
                run.push(event);
            }
        } catch (error) {
            // An abort is /agent/stop doing its job, not a failure, settle as a stop. Detected by name, not
            // instanceof: Node's DOMException AbortError does not inherit from Error.
            stopped = typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
            if (!stopped) {
                failure = error instanceof Error ? error.message : "agent turn failed";
                run.push({ kind: "error", message: failure });
            }
            run.push({ kind: "done" });
        } finally {
            run.finish(stopped ? "stopped" : "settled");
            // Expiry is proactive, not opportunistic on the next route call. Otherwise the last completed run
            // in a quiet sandbox holds its rows forever.
            const expiry = setTimeout(() => {
                if (runs.get(input.conversationId) === run) {
                    runs.delete(input.conversationId);
                }
            }, RETAIN_MS);
            expiry.unref();
            /* The conversation's durable transcript, written once the turn is WHOLE, a settled failure and an
             * abort included, because both are things the user watched happen and will look for when they come
             * back. Guarded on both sides like `tell`: a sink that throws where it stands and one whose write
             * rejects are the same kind of side-channel failure, and neither may reach a turn that is otherwise
             * finished. The cost is one turn missing from a conversation's history. */
            if (transcript !== undefined) {
                try {
                    // Journal deletion is the commit point for a turn. Await the transcript before crossing it:
                    // fire-and-forget opened a window where a crash could lose both the still-running journal
                    // and the not-yet-appended transcript even though each file was durable on its own.
                    await transcript(run.rows, run.steerRows).catch(() => undefined);
                } catch {
                    // Nothing to do and nowhere to report it, the turn is the thing that matters.
                }
            }
            // This turn is no longer in flight, however it ended, a failure and an abort are both settled
            // outcomes the user has seen, and only a turn nobody got to see the end of deserves resuming.
            // Queued behind the writes above, never racing them (see the note where journalOp is defined).
            journalOp((target) => target.clearTurn(input.conversationId));
            tell((target) => target.settled(failure === undefined ? { ok: true } : { ok: false, error: failure }));
            notifySettled(input.conversationId);
        }
    })();
    return run;
}

// The conversation's current run, live, or finished within retention. Undefined = nothing to attach to.
export function turnRunOf(conversationId: string): TurnRun | undefined {
    sweep();
    return runs.get(conversationId);
}

// The one conversation with a LIVE run, when exactly one exists, how a caller that knows it was spawned by
// "the" running turn but not which conversation (an agent CLI under a harness that stamps no conversation id
// into its shell) finds the chat its card belongs in. Two live runs are an honest "don't know": guessing
// would park a card in somebody else's conversation, so the caller refuses instead.
export function soleLiveConversation(): string | undefined {
    sweep();
    let found: string | undefined;
    for (const [conversationId, run] of runs) {
        if (run.done) {
            continue;
        }
        if (found !== undefined) {
            return undefined;
        }
        found = conversationId;
    }
    return found;
}

/* Every conversation with a turn still running, with the moment it started. `turnRunOf` answers for one
 * conversation and `soleLiveConversation` refuses to guess between two; this is the whole set, for the two
 * readers that have to compare it against a SECOND record of the same fact, the journal on disk and the fleet
 * registry's own `running` flags (invariants/). `startedAt` rides along because both of those records are
 * written asynchronously, so a comparison that did not know a run's age would report every turn younger than
 * its own first write as a violation. */
export function liveTurnConversations(): readonly { readonly conversationId: string; readonly startedAt: number }[] {
    sweep();
    return [...runs].filter(([, run]) => !run.done).map(([conversationId, run]) => ({ conversationId, startedAt: run.startedAt }));
}

export const turnRunMetrics = (): Readonly<Record<string, number>> => {
    sweep();
    let live = 0;
    let retained = 0;
    let rows = 0;
    let followers = 0;
    for (const run of runs.values()) {
        live += run.done ? 0 : 1;
        retained += run.done ? 1 : 0;
        const held = run.metrics();
        rows += held.rows;
        followers += held.followers;
    }
    return { runs: runs.size, live, retained, rows, followers };
};
