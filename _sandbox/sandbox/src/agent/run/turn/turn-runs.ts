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
import { recordCommands } from "../../providers/agent-commands.js";
import type { TurnJournal } from "./turn-journal.js";

// Turn execution decoupled from any client connection: POST /agent starts a run, folds the transcript frame by frame,
// and any number of clients attach to it live. Holds rows, not frames, keyed by conversationId; a finished run is
// retained briefly so a late attach still finds it, then reports NOT_FOUND.

// The turn generator a run pumps, streamAgent's shape; injected to keep this module free of a cycle with agent.routes
// (and swappable in tests).
export type TurnFn = (input: AgentTurn, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;

// The two moments a turn's starter might want reported: when it parks and when it settles. This module knows only WHEN;
// agent.routes owns the wording and whether to send at all.
export interface TurnObserver {
    // Agent waits on the user (plan, question, permission, browser/terminal handover); may fire several times.
    readonly awaiting: (kind: "plan" | "question" | "permission" | "browser_help" | "terminal_help") => void;
    // Run ended, exactly once; `error` only for a real failure, a /agent/stop abort settles as a clean "done".
    readonly settled: (outcome: { readonly ok: boolean; readonly error?: string }) => void;
}

// A reconnect retries within seconds; one minute covers the reconnect ladder with ample margin.
const RETAIN_MS = 60_000;

// One entry of the attach stream past its head: a change to the rows, or a fact about the turn.
export type AttachEntry = Extract<AttachFrame, { kind: "patch" | "fact" }>;
export type AttachHead = Extract<AttachFrame, { kind: "attached" }>;

// One subscriber's queue; a follower holds only what it has not yet read, so a stalled reader's backlog never reaches
// the others.
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

    // Everything pushed, in order, until closed and drained. `released` runs however the reader leaves, including early
    // exit, so the queue never leaks.
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
    // One transcript fold per subagent, tagged by the call that spawned it; keeps only frames carrying its tag.
    private readonly children = new Map<string, TranscriptFold>();
    // Facts so far, replayed to every attach so a late window learns which session and branch the turn is on.
    private readonly facts: AttachEntry[] = [];
    private seq = 0;
    private readonly followers = new Set<Mailbox<AttachEntry>>();
    private readonly listeners = new Set<Mailbox<AgentEvent>>();
    private waiters: (() => void)[] = [];

    constructor(
        // The user's message the turn opens with, or the notice standing in for a repeated one.
        opening: readonly TranscriptRow[],
        readonly startedAt = Date.now(),
    ) {
        this.fold = new TranscriptFold(opening);
    }

    get done(): boolean {
        return this.finishedAt !== undefined;
    }

    // True once the run is finished AND past retention; attach then reports NOT_FOUND and the map entry drops.
    expired(now: number): boolean {
        return this.finishedAt !== undefined && now - this.finishedAt > RETAIN_MS;
    }

    // The transcript as it stands, live: what the record keeps once whole, and what a reopened tab draws meanwhile.
    get rows(): readonly TranscriptRow[] {
        return this.fold.rows;
    }

    // Rows where the user's mid-turn messages landed, for the anchors filed under them at settlement.
    get steerRows(): readonly number[] {
        return this.fold.steerRows;
    }

    // One helper's transcript, by the id of the call that spawned it; empty if this run heard nothing from it.
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

    // A row the daemon writes on the turn's behalf (a decision's notice, feedback answering a card).
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

    // Resolves only once the detached pump has fully unwound; stop uses this as its acknowledgement boundary.
    async waitUntilFinished(): Promise<void> {
        while (!this.done) {
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }
    }

    // Attach: rows and facts so far on the head, then everything that lands from this instant on. Head and subscription
    // are taken in one synchronous step, so nothing lands between the snapshot and the first live entry.
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

    // Raw frames from this instant on, for the daemon's own readers of a turn (a child's supervisor, a loop); nothing
    // before now.
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

// Module-level settle notice for machinery watching every run (the resource reaper); guarded like `tell`.
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
            // Nothing to do and nowhere to report it.
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

// Everything a run needs beyond the turn; every field optional, since the turn must run without any of them.
export interface RunOptions {
    readonly observer?: TurnObserver;
    // Where the in-flight turn is written down so a daemon death doesn't lose it; injected like TurnFn.
    readonly journal?: TurnJournal;
    // What the transcript opens with, at start time; built by whoever holds the prompt (turn-transcript.ts).
    readonly opening?: (startedAt: number) => readonly TranscriptRow[];
    // Where the settled turn's durable transcript is written down (sessions/transcript-record.ts).
    readonly transcript?: (rows: readonly TranscriptRow[], steerRows: readonly number[]) => Promise<unknown>;
    // Side-channel prep that must precede the provider; its failure may cost persistence, never the turn itself.
    readonly before?: Promise<unknown>;
    // How many boots already re-ran this turn, so a resume that dies again isn't resumed a third time; starts at 0.
    readonly attempts?: number;
}

// Starts a detached run for the conversation's turn, or undefined if one is already live (caller 409s). Owns the
// generator: a thrown turn folds into the transcript as an error, so followers always see the run settle.
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
    // Journal writes are serialized so a clear can never race the opening write or a session update.
    let journalled: Promise<unknown> = Promise.resolve();
    const journalOp = (op: (target: TurnJournal) => Promise<void>): void => {
        if (journal === undefined) {
            return;
        }
        journalled = journalled.then(() => op(journal)).catch(() => undefined);
    };
    // Journal entry's live fields; snapshotted synchronously so a rewrite always carries all of them.
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
    // An observer is an optional side-channel; a throw from it must not abort an otherwise-fine run.
    const tell = (report: (target: TurnObserver) => void): void => {
        if (observer === undefined) {
            return;
        }
        try {
            report(observer);
        } catch {
            // Nothing to do and nowhere to report it.
        }
    };
    void (async () => {
        // Set by the error frame below (or a provider emitting one mid-stream), read once at settle.
        let failure: string | undefined;
        let stopped = false;
        try {
            await before;
            for await (const event of turnFn(input, undefined)) {
                // Every provider republishes its slash commands each turn; cache the latest (agent-commands.ts).
                if (event.kind === "commands") {
                    recordCommands(provider, event.items);
                }
                // Frames that park the turn on the user; they keep the run's fetch open, so it still looks live.
                if (
                    event.kind === "plan" ||
                    event.kind === "question" ||
                    event.kind === "permission" ||
                    event.kind === "browser_help" ||
                    event.kind === "terminal_help"
                ) {
                    tell((target) => target.awaiting(event.kind));
                }
                // Restorable cards ride the journal entry while up (handovers excluded) and come off as each resolves.
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
                // Session the provider minted, folded into the journal entry once known; a resume without it starts
                // over.
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
            // An abort is /agent/stop, not a failure. Detected by name: DOMException AbortError doesn't extend Error.
            stopped = typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError";
            if (!stopped) {
                failure = error instanceof Error ? error.message : "agent turn failed";
                run.push({ kind: "error", message: failure });
            }
            run.push({ kind: "done" });
        } finally {
            run.finish(stopped ? "stopped" : "settled");
            // Expiry is proactive, or the last completed run in a quiet sandbox would hold its rows forever.
            const expiry = setTimeout(() => {
                if (runs.get(input.conversationId) === run) {
                    runs.delete(input.conversationId);
                }
            }, RETAIN_MS);
            expiry.unref();
            // Durable transcript, written once the turn is whole, including a settled failure or an abort.
            if (transcript !== undefined) {
                try {
                    // Journal deletion is the commit point; await the transcript first so a crash can't lose both.
                    await transcript(run.rows, run.steerRows).catch(() => undefined);
                } catch {
                    // Nothing to do and nowhere to report it.
                }
            }
            // No longer in flight, however it ended; only an unseen turn deserves resuming. Queued behind the writes
            // above.
            journalOp((target) => target.clearTurn(input.conversationId));
            tell((target) => target.settled(failure === undefined ? { ok: true } : { ok: false, error: failure }));
            notifySettled(input.conversationId);
        }
    })();
    return run;
}

// The conversation's current run, live or finished within retention; undefined means nothing to attach to.
export function turnRunOf(conversationId: string): TurnRun | undefined {
    sweep();
    return runs.get(conversationId);
}

// The one conversation with a live run, when exactly one exists. Two live runs are an honest "don't know": guessing
// would park a card in the wrong conversation.
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

// Every conversation with a turn still running, with when it started; the full set, for readers comparing it against a
// second record of the same fact (journal, fleet registry).
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
