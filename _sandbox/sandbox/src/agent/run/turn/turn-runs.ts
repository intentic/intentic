import {
    type AgentEvent,
    isParkKind,
    isTurnFact,
    type ParkedRequest,
    type ParkKind,
    type TranscriptPatch,
    type TranscriptRow,
    type TurnFact,
    withRuntimeDefaults,
} from "@intentic/sandbox-contract";
import { TranscriptFold, type TurnEnding } from "@intentic/sandbox-contract/transcript-fold";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { type AttachedRun, type AttachEntry, type AttachHead, type LiveRun, RUN_RETAINED_MS, RUNS } from "../../../conversations/actor/conversation-holdings.js";
import type { BeginRefusal } from "../../../conversations/actor/conversation-decide.js";
import type { DomainEvents } from "../../../seams/domain-events.js";
import type { RoutedTurn, TurnInput, TurnStarter } from "../../../seams/turn-starter.js";
import type { JournalledTurn } from "./turn-journal.js";
import { recordCommands } from "../../providers/agent-commands.js";
import { type FrameBacklog, frameBacklog } from "../../../seams/frame-backlog.js";

// Turn execution decoupled from any client connection: POST /agent starts a run, folds the transcript frame by frame,
// and any number of clients attach to it live. Holds rows, not frames; each run is held by its conversation's actor
// (RUNS), retained briefly past its settle so a late attach still finds it, then reports NOT_FOUND.

// The two moments a turn's starter might want reported: when it parks and when it settles. This module knows only WHEN;
// the starter owns the wording and whether to send at all.
export interface TurnObserver {
    // Agent waits on the user on any card it can park on; may fire several times.
    readonly awaiting: (kind: ParkKind) => void;
    // Run ended, exactly once; `error` only for a real failure, a /agent/stop abort settles as a clean "done".
    readonly settled: (outcome: { readonly ok: boolean; readonly error?: string }) => void;
}

// One subscriber's queue; a follower holds only what it has not yet read, so a stalled reader's backlog never reaches
// the others. A bounded one is cut past frame-backlog's bound, its reader ending with the error it was given so it
// re-attaches for a fresh head; the daemon's own readers are unbounded, reading as they are fed.
class Mailbox<T> {
    private readonly queue: FrameBacklog<T>;
    private wake: (() => void) | undefined;
    private closed = false;
    private failure: Error | undefined;

    constructor(replay: readonly T[], bounded: { readonly failure: () => Error; readonly onCut: () => void } | undefined) {
        this.queue = frameBacklog<T>(
            () => {
                if (bounded !== undefined) {
                    this.cut(bounded.failure());
                    bounded.onCut();
                }
            },
            bounded === undefined ? { frames: Infinity, waitMs: Infinity } : {},
        );
        for (const item of replay) {
            this.queue.push(item);
        }
    }

    push(item: T): void {
        if (this.closed) {
            return;
        }
        this.queue.push(item);
        this.wake?.();
    }

    close(): void {
        this.closed = true;
        this.wake?.();
    }

    // Ends the reader with `error` as soon as it next reads; nothing queued is delivered after the cut.
    cut(error: Error): void {
        if (this.failure !== undefined) {
            return;
        }
        this.failure = error;
        this.closed = true;
        this.wake?.();
    }

    // Everything pushed, in order, until closed and drained, or until cut. `released` runs however the reader leaves,
    // including early exit, so the queue never leaks.
    async *drain(released: () => void): AsyncGenerator<T> {
        try {
            for (;;) {
                if (this.failure !== undefined) {
                    throw this.failure;
                }
                const next = this.queue.shift();
                if (next !== undefined) {
                    yield next.frame;
                    continue;
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

export class TurnRun implements LiveRun {
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
        return this.finishedAt !== undefined && now - this.finishedAt > RUN_RETAINED_MS;
    }

    // The transcript as it stands, live: what the record keeps once whole, and what a reopened tab draws meanwhile.
    // Stamped on the way out, the one place a row leaves this run, so every copy of it says which run made it and a
    // client redrawing the run knows where it already sits.
    get rows(): readonly TranscriptRow[] {
        return this.fold.rows.map((row) => ({ ...row, run: this.id }));
    }

    // Rows where the user's mid-turn messages landed, for the anchors filed under them at settlement.
    get steerRows(): readonly number[] {
        return this.fold.steerRows;
    }

    // Whether this turn was refused before it ran, with its message handed back to the conversation's queue; such a run
    // is not written down (see the settle below).
    get ranNothing(): boolean {
        return this.fold.ranNothing;
    }

    // Whether this frame turns the whole turn away at the door, asked before it is pushed (TranscriptFold.turnedAway).
    turnedAway(event: AgentEvent): boolean {
        return this.fold.turnedAway(event);
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
    // are taken in one synchronous step, so nothing lands between the snapshot and the first live entry. A follower whose
    // connection aborts is let go at once; one that falls behind ends with `fellBehind`'s error, and `cut` with the caller's.
    attach(fellBehind: () => Error, signal?: AbortSignal): AttachedRun {
        const mailbox: Mailbox<AttachEntry> = new Mailbox<AttachEntry>(this.facts, { failure: fellBehind, onCut: () => this.followers.delete(mailbox) });
        const abandon = (): void => {
            this.followers.delete(mailbox);
            mailbox.close();
        };
        const head: AttachHead = {
            kind: "attached",
            run: this.id,
            startedAt: this.startedAt,
            seq: this.seq,
            rows: this.rows.map((row) => structuredClone(row)),
        };
        if (this.done || signal?.aborted === true) {
            mailbox.close();
        } else {
            this.followers.add(mailbox);
            signal?.addEventListener("abort", abandon, { once: true });
        }
        return {
            head,
            entries: mailbox.drain(() => {
                this.followers.delete(mailbox);
                signal?.removeEventListener("abort", abandon);
            }),
            cut: (error) => mailbox.cut(error),
        };
    }

    // Raw frames from this instant on, for the daemon's own readers of a turn (a child's supervisor, a loop); nothing
    // before now.
    frames(): AsyncGenerator<AgentEvent> {
        const mailbox = new Mailbox<AgentEvent>([], undefined);
        if (this.done) {
            mailbox.close();
        } else {
            this.listeners.add(mailbox);
        }
        return mailbox.drain(() => this.listeners.delete(mailbox));
    }

    // The delta half of the same stamp the `rows` getter puts on the snapshot: a row reaching a client by patch is no
    // less this run's, and one arriving unmarked would leave a gap in what a redraw can recognise.
    private stamped(patch: TranscriptPatch): TranscriptPatch {
        return patch.op === "append" || patch.op === "replace" ? { ...patch, row: { ...patch.row, run: this.id } } : patch;
    }

    private publish(patches: readonly TranscriptPatch[], fact?: TurnFact): void {
        for (const patch of patches) {
            this.deliver({ kind: "patch", seq: ++this.seq, patch: this.stamped(patch) });
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

const closingOf = (rows: readonly TranscriptRow[]): string =>
    rows.findLast((row) => row.role === "assistant" && row.text.trim() !== "")?.text.trim() ?? "";

// A refusal whose turn the daemon keeps whole: `ran: false`, since a door refusal is decided before any request.
const heldWhole = (event: AgentEvent): AgentEvent => (event.kind === "error" ? { ...event, held: { ran: false } } : event);

// Everything a run needs beyond the turn; every field optional, since the turn must run without any of them.
export interface RunOptions {
    readonly observer?: TurnObserver;
    // Whether the in-flight turn is written down so a daemon death doesn't lose it: filed with the conversation's actor,
    // whose `begin` writes it with the turn's opening entry (turn-journal.ts).
    readonly journalled?: boolean;
    // What the transcript opens with, at start time; built by whoever holds the prompt (turn-transcript.ts).
    readonly opening?: (startedAt: number) => readonly TranscriptRow[];
    // Where the settled turn's durable transcript is written down (sessions/transcript-record.ts).
    readonly transcript?: (rows: readonly TranscriptRow[], steerRows: readonly number[]) => Promise<unknown>;
    // Side-channel prep that must precede the provider; its failure may cost persistence, never the turn itself.
    readonly before?: Promise<unknown>;
    // How many boots already re-ran this turn, so a resume that dies again isn't resumed a third time; starts at 0.
    readonly attempts?: number;
    // Keeps a turn turned away at the door when no sender keeps its words: the refusal goes out marked held, so its
    // message stays in the record, and this is handed the turn to hold for a press. Absent, the sender keeps them (the
    // composer behind POST /agent), and the refusal hands them back instead.
    readonly holdTurnedAway?: (turnedAway: { readonly input: TurnInput & { readonly conversationId: string }; readonly run: string }) => void;
}

// Where a run is filed and announced: its conversation's actor holds it, and its settle is told to whoever reacts.
export interface RunDeps {
    readonly conversations: Pick<ConversationActors, "archived" | "holdings" | "send">;
    readonly events: Pick<DomainEvents, "publish">;
}

// Starts a detached run for the conversation's turn, or names why not: one is live, or it is archived, which leaves no
// run behind. A thrown turn folds into the transcript as an error, so followers see it settle.
export function startTurnRun(
    deps: RunDeps,
    turnFn: TurnStarter["stream"],
    sent: TurnInput & { readonly conversationId: string },
    { observer, journalled = false, opening, transcript, before, attempts = 0, holdTurnedAway }: RunOptions = {},
): TurnRun | BeginRefusal {
    // Routed on the way in (idempotent), for a caller that starts a run without the port.
    const input: RoutedTurn & { readonly conversationId: string } = withRuntimeDefaults(sent);
    if (deps.conversations.archived(input.conversationId)) {
        return "archived";
    }
    const runs = deps.conversations.holdings(RUNS);
    if (runs.get(input.conversationId)?.done === false) {
        return "busy";
    }
    const startedAt = Date.now();
    const run = new TurnRun(opening?.(startedAt) ?? [], startedAt);
    runs.hold(input.conversationId, input.conversationId, run);
    const provider = input.agent;
    // Told to the actor in order, which writes them in order; a failed write costs the journal, never the turn.
    const journal = (event: { readonly kind: "journalled"; readonly entry: JournalledTurn } | { readonly kind: "unjournalled" }): void => {
        if (journalled) {
            // allow(silent-catch): a failed journal write costs the journal, never the turn.
            void deps.conversations.send(input.conversationId, event).settled.catch(() => undefined);
        }
    };
    // Journal entry's live fields; snapshotted synchronously so a rewrite always carries all of them.
    let sessionId: string | undefined;
    const parked: ParkedRequest[] = [];
    const journalEntry = (): void =>
        journal({
            kind: "journalled",
            entry: {
                kind: "turn",
                turn: input,
                startedAt: run.startedAt,
                attempts,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(parked.length > 0 ? { parked: [...parked] } : {}),
            },
        });
    journalEntry();
    // An observer is an optional side-channel; a throw from it must not abort an otherwise-fine run.
    const tell = (report: (target: TurnObserver) => void): void => {
        if (observer === undefined) {
            return;
        }
        try {
            report(observer);
        } catch {
            // allow(silent-catch): an observer's own throw is its problem; the run it watches carries on.
        }
    };
    // Held before it is folded, so the fold keeps the message a refusal at the door would otherwise take back.
    const kept = (frame: AgentEvent): AgentEvent => {
        if (holdTurnedAway === undefined || !run.turnedAway(frame)) {
            return frame;
        }
        holdTurnedAway({ input, run: run.id });
        return heldWhole(frame);
    };
    void (async () => {
        // Set by the error frame below (or a provider emitting one mid-stream), read once at settle.
        let failure: string | undefined;
        let stopped = false;
        try {
            await before;
            for await (const frame of turnFn(input, undefined)) {
                const event = kept(frame);
                // Every provider republishes its slash commands each turn; cache the latest (agent-commands.ts).
                if (event.kind === "commands") {
                    recordCommands(provider, event.items);
                }
                // Frames that park the turn on the user; they keep the run's fetch open, so it still looks live.
                if (isParkKind(event.kind)) {
                    const awaiting = event.kind;
                    tell((target) => target.awaiting(awaiting));
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
                    runs.drop(input.conversationId);
                }
            }, RUN_RETAINED_MS);
            expiry.unref();
            // Durable transcript, written once the turn is whole, including a settled failure or an abort; a turn
            // refused before it ran is not written at all, since the conversation's queue holds its message for another
            // press.
            if (transcript !== undefined && !run.ranNothing) {
                // Journal deletion is the commit point; await the transcript first so a crash can't lose both.
                try {
                    await transcript(run.rows, run.steerRows);
                } catch {
                    // allow(silent-catch): a transcript that fails to write must not hold the journal open; the turn has settled.
                }
            }
            // No longer in flight, however it ended; only an unseen turn deserves resuming.
            journal({ kind: "unjournalled" });
            tell((target) => target.settled(failure === undefined ? { ok: true } : { ok: false, error: failure }));
            deps.events.publish("run.settled", {
                conversationId: input.conversationId,
                actor: input.actor,
                speaker: input.speaker,
                failure,
                closing: closingOf(run.rows),
            });
        }
    })();
    return run;
}
