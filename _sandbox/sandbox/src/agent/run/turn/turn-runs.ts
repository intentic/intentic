import { type AgentEvent, isTurnFact, type TurnFact } from "@intentic/sandbox-contract/events/agent-events";
import { isParkKind, type ParkKind } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { isRestorableRequest, type ParkedRequest } from "@intentic/sandbox-contract/events/requests";
import type { TranscriptPatch, TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import { TranscriptFold, type TurnEnding } from "@intentic/sandbox-contract/transcript-fold";
import type { Logger } from "pino";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { type AttachedRun, type AttachEntry, type AttachHead, type LiveRun, RUN_RETAINED_MS, RUNS } from "../../../conversations/actor/conversation-holdings.js";
import type { BeginRefusal } from "../../../conversations/actor/conversation-decide.js";
import type { DomainEvents } from "../../../seams/domain-events.js";
import type { RoutedTurn, TurnInput, TurnStarter } from "../../../seams/turn-starter.js";
import type { JournalledTurn } from "../../../store/journals/turn-journal.js";
import { opt } from "../../../opt.js";
import { commandListOf, recordCommands } from "../../providers/agent-commands.js";
import { Mailbox } from "../../../seams/frame-backlog.js";
import { turnPulseOf } from "./turn-pulse.js";
import { settledOf } from "./turn-closing.js";
import { planAnswerRows } from "./plan-answer.js";
import type { RunLog, RunLogHead } from "../../../sessions/run-log.js";
import { RunRowIds } from "./run-row-ids.js";

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

export class TurnRun implements LiveRun {
    // Whether the turn journal holds it; the unjournalled door (a loop's iteration) says otherwise as it starts it.
    journalled = true;
    private finishedAt: number | undefined;
    // Set once the settled run is on the record (or its write is over, landed or not): what ends its followers' streams.
    private isRecorded = false;
    private readonly fold: TranscriptFold;
    // Each row's own id, kept in step with the fold's rows (run-row-ids.ts).
    private readonly rowIds: RunRowIds;
    // Facts so far, replayed to every attach so a late window learns which session and branch the turn is on.
    private readonly facts: AttachEntry[] = [];
    private seq = 0;
    private readonly followers = new Set<Mailbox<AttachEntry>>();
    private readonly listeners = new Set<Mailbox<AgentEvent>>();
    private waiters: (() => void)[] = [];
    // Resolved once the settled run's durable transcript is written (or was not to be) and its journal entry is gone.
    private markRecorded: () => void = () => undefined;
    // Hears every patch the run publishes, as it publishes it: the run log a restart reads back (sessions/run-log.ts).
    tap: ((patches: readonly TranscriptPatch[]) => void) | undefined;
    // Hears every frame once it is folded, whoever pushed it: the pump, or a gate raising its card outside the turn.
    watch: ((event: AgentEvent) => void) | undefined;
    private readonly recorded = new Promise<void>((resolve) => {
        this.markRecorded = resolve;
    });

    constructor(
        // The user's message the turn opens with, or the notice standing in for a repeated one; for a run carried on
        // after a restart, everything it had drawn.
        opening: readonly TranscriptRow[],
        readonly startedAt = Date.now(),
        // Minted here, unless this run carries on one a restart cut (RunOptions.continues): a window showing that run
        // finds it by this id and redraws it in place, where a new id would draw it a second time beneath.
        readonly id: string = crypto.randomUUID(),
    ) {
        // The live fold, on the daemon's clock: what dates each card and bubble in the record (TranscriptFold's `now`).
        this.fold = new TranscriptFold(opening, Date.now);
        // A run carried on after a restart keeps the ids its rows were drawn under, which the windows showing it hold.
        this.rowIds = new RunRowIds(opening);
    }

    get done(): boolean {
        return this.finishedAt !== undefined;
    }

    get onRecord(): boolean {
        return this.isRecorded;
    }

    // True once the run is finished AND past retention; attach then reports NOT_FOUND and the map entry drops.
    expired(now: number): boolean {
        return this.finishedAt !== undefined && now - this.finishedAt > RUN_RETAINED_MS;
    }

    // The transcript as it stands, live: what the record keeps once whole, and what a reopened tab draws meanwhile.
    // Stamped on the way out, the one place a row leaves this run, so every copy of it says which run made it and a
    // client redrawing the run knows where it already sits.
    get rows(): readonly TranscriptRow[] {
        return this.fold.rows.map((row, index) => ({ ...row, run: this.id, rowId: this.rowIds.at(index) }));
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

    metrics(): { readonly rows: number; readonly followers: number } {
        return { rows: this.fold.rows.length, followers: this.followers.size };
    }

    push(event: AgentEvent): void {
        const notes = planAnswerRows(this.fold.rows, event);
        this.publish([...this.fold.apply(event), ...notes.flatMap((row) => this.fold.note(row))], isTurnFact(event) ? event : undefined);
        for (const listener of this.listeners) {
            listener.push(event);
        }
        this.watch?.(event);
    }

    // A row the daemon writes on the turn's behalf (a decision's notice, feedback answering a card).
    note(row: TranscriptRow): void {
        this.publish(this.fold.note(row));
    }

    // The run's last rows, and the end of its hold on the conversation. Its followers' streams stay open until it is on
    // the record too (recordedNow): a reader that asks the record for the run once its stream ends then finds it there.
    finish(ending: TurnEnding = "settled"): void {
        this.publish(this.fold.finish(ending));
        this.finishedAt = Date.now();
        this.wake();
    }

    // Resolves once the run has finished: its last frame is folded and it no longer holds the conversation. Stop uses this
    // as its acknowledgement boundary. The durable transcript may still be being written then (waitUntilRecorded).
    async waitUntilFinished(): Promise<void> {
        while (!this.done) {
            await new Promise<void>((resolve) => {
                this.waiters.push(resolve);
            });
        }
    }

    /**
     * Resolves once the settled run is on the record: its transcript written and its journal entry gone. What follows
     * this run in its conversation and writes the record too waits for this, or its rows land above this run's: a parked
     * turn's answer started on waitUntilFinished was recorded before the work it answered on a loaded machine.
     */
    waitUntilRecorded(): Promise<void> {
        return this.recorded;
    }

    /**
     * @internal The pump's own end: everything a settled run writes is written, or failed to be. Only now do its streams
     * end, so `end` on an attach means every row was delivered AND the record holds them (unless its write failed, which
     * the next writer of this conversation's record makes good).
     */
    recordedNow(): void {
        this.isRecorded = true;
        for (const follower of this.followers) {
            follower.close();
        }
        for (const listener of this.listeners) {
            listener.close();
        }
        this.markRecorded();
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
        // A run finished but not yet recorded keeps a late follower too: its head is the whole run, and its end comes with
        // the record.
        if (this.isRecorded || signal?.aborted === true) {
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
    // before now. Ends once the run is on the record, like an attach.
    frames(): AsyncGenerator<AgentEvent> {
        const mailbox = new Mailbox<AgentEvent>([], undefined);
        if (this.isRecorded) {
            mailbox.close();
        } else {
            this.listeners.add(mailbox);
        }
        return mailbox.drain(() => this.listeners.delete(mailbox));
    }

    private publish(patches: readonly TranscriptPatch[], fact?: TurnFact): void {
        // The delta half of the stamp the `rows` getter puts on the snapshot: a row reaching a client by patch is no less
        // this run's, and names itself as every other copy of it does.
        const stamped = patches.map((patch) => this.rowIds.stamp(patch, this.id));
        for (const patch of stamped) {
            this.deliver({ kind: "patch", seq: ++this.seq, patch });
        }
        if (stamped.length > 0) {
            this.tap?.(stamped);
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
    // The run a restart cut while it waited on a person, carried on as itself (turn-resume.ts, rehydrateParkedTurn): its
    // id, its start, and the rows it had drawn, which stand in for `opening`. Absent, the run is a new one.
    readonly continues?: { readonly id: string; readonly startedAt: number; readonly rows: readonly TranscriptRow[] };
    // Where the settled turn's durable transcript is written down (sessions/transcript-record.ts); `false` is a write
    // that did not land, which keeps the run's log and its journal entry for whoever records it next.
    readonly transcript?: (rows: readonly TranscriptRow[], steerRows: readonly number[]) => Promise<unknown>;
    // Opens the log a journalled run's rows are written to as they are drawn (sessions/run-log.ts), what a boot after a
    // death mid-turn records the turn from.
    readonly log?: (head: RunLogHead) => RunLog;
    // Side-channel prep that must precede the provider; its failure may cost persistence, never the turn itself.
    readonly before?: Promise<unknown>;
    // Names the provider, model and knobs the turn's persona or run role pins (turn-routing.ts), asked of the turn as it was
    // sent after the run is claimed, so the door still answers at once and its starter reads the frames from the first one. The pump waits for
    // it; the provider runs the routed turn, and a journalled run's entry is written again with it. A failure to route is
    // the turn's own failure. Absent, the turn is already as it will run.
    readonly route?: (turn: TurnInput & { readonly conversationId: string }) => Promise<RoutedTurn & { readonly conversationId: string }>;
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
    // Where the run's accepted and ended lines go; a suite with no logger writes none.
    readonly logger?: Pick<Logger, "info">;
}

// How much of a failure's sentence the ended line keeps: the failure's own line has it whole.
const ENDED_FAILURE_CHARS = 200;

/**
 * Who or what started a turn, as one word a log line is filtered on: a run carried on after a restart, a re-run (of a
 * restart's cut turn, a parked card's answer, a person's Continue, a held turn), else whoever is speaking.
 */
export const startedByOf = (turn: Pick<TurnInput, "resume" | "speaker">, carried: boolean): string => {
    if (carried) {
        return "rehydrate";
    }
    switch (turn.resume) {
        case undefined:
            break;
        case "restart":
            return "auto-resume";
        case "answered":
            return "answer";
        case "continued":
            return "continue";
        default:
            return `rerun:${turn.resume}`;
    }
    const { speaker } = turn;
    if (speaker === undefined) {
        return "sandbox";
    }
    return speaker.kind === "sandbox" && speaker.source !== undefined ? `sandbox:${speaker.source}` : speaker.kind;
};

// How a run ended, in the word its ended line carries.
const endingOf = (run: TurnRun, stopped: boolean, failure: string | undefined): string => {
    if (stopped) {
        return "stopped";
    }
    if (run.ranNothing) {
        return "turned-away";
    }
    return failure === undefined ? "ok" : "failed";
};

// What an error frame says of a re-run of this same turn the sandbox booked for itself: when it fires, where known.
const bookedRerun = (event: Extract<AgentEvent, { kind: "error" }>): { readonly at?: number } | undefined => {
    if (event.autoResume !== "scheduled") {
        return undefined;
    }
    return event.nextAt === undefined ? {} : { at: event.nextAt };
};

// Expiry is proactive, or the last completed run in a quiet sandbox would hold its rows forever.
const expireRetained = (deps: RunDeps, conversationId: string, run: TurnRun): void => {
    const runs = deps.conversations.holdings(RUNS);
    const expiry = setTimeout(() => {
        if (runs.get(conversationId) === run) {
            runs.drop(conversationId);
        }
    }, RUN_RETAINED_MS);
    expiry.unref();
};

// The settled run onto the record: true once its rows are there, or there was nothing to write (a turn refused before it
// ran is not written at all, since the conversation's queue holds its message for another press); false for a write
// that did not land.
const writeSettled = async (run: TurnRun, transcript: RunOptions["transcript"]): Promise<boolean> => {
    if (transcript === undefined || run.ranNothing) {
        return true;
    }
    try {
        return (await transcript(run.rows, run.steerRows)) !== false;
    } catch {
        // allow(silent-catch): a write that threw is one that did not land, which the answer carries on.
        return false;
    }
};

// A run of its own, opening on what `opening` builds for the instant it starts.
const newRun = (opening: RunOptions["opening"]): TurnRun => {
    const startedAt = Date.now();
    return new TurnRun(opening?.(startedAt) ?? [], startedAt);
};

// Starts a detached run for the conversation's turn, or names why not: one is live, or it is archived, which leaves no
// run behind. A thrown turn folds into the transcript as an error, so followers see it settle.
export function startTurnRun(
    deps: RunDeps,
    turnFn: TurnStarter["stream"],
    sent: TurnInput & { readonly conversationId: string },
    { observer, journalled = false, opening, continues, transcript, log: openLog, before, route, attempts = 0, holdTurnedAway }: RunOptions = {},
): TurnRun | BeginRefusal {
    // Routed on the way in (idempotent), for a caller that starts a run without the port.
    let input: RoutedTurn & { readonly conversationId: string } = withRuntimeDefaults(sent);
    if (deps.conversations.archived(input.conversationId)) {
        return "archived";
    }
    const runs = deps.conversations.holdings(RUNS);
    if (runs.get(input.conversationId)?.done === false) {
        return "busy";
    }
    const run = continues === undefined ? newRun(opening) : new TurnRun(continues.rows, continues.startedAt, continues.id);
    run.journalled = journalled;
    runs.hold(input.conversationId, input.conversationId, run);
    deps.logger?.info(
        {
            conversationId: input.conversationId,
            run: run.id,
            startedBy: startedByOf(input, continues !== undefined),
            provider: input.agent,
            harness: input.harness,
            ...opt("model", input.model === "" ? undefined : input.model),
            ...opt("account", input.account),
            ...opt("errand", input.errand),
            ...(attempts > 0 ? { attempts } : {}),
            ...(journalled ? {} : { journalled: false }),
        },
        "turn accepted",
    );
    // Told to the actor in order, which writes them in order; a failed write costs the journal, never the turn. Each
    // names this run, so its clear cannot take off the record of a run started after it finished.
    const journal = (event: { readonly kind: "journalled"; readonly entry: JournalledTurn } | { readonly kind: "unjournalled" }): void => {
        if (journalled) {
            // allow(silent-catch): a failed journal write costs the journal, never the turn.
            void deps.conversations.send(input.conversationId, { ...event, run: run.id }).settled.catch(() => undefined);
        }
    };
    // Journal entry's live fields; snapshotted synchronously so a rewrite always carries all of them.
    let sessionId: string | undefined;
    const parked: ParkedRequest[] = [];
    // While a card is up the run's rows ride along, the only copy of them a restart leaves; once none is, they are let go.
    // `settled`: the turn ended but its record did not take it, so a boot records it rather than running it again.
    const journalEntry = (settled = false): void =>
        journal({
            kind: "journalled",
            entry: {
                kind: "turn",
                turn: input,
                startedAt: run.startedAt,
                attempts,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...(parked.length > 0 && !settled ? { parked: [...parked] } : {}),
                // Cloned: the fold goes on changing the cards these rows share with it, under a write still queued.
                run: {
                    id: run.id,
                    ...opt("rows", parked.length > 0 || settled ? structuredClone([...run.rows]) : undefined),
                    ...(settled ? { settled: true as const } : {}),
                },
            },
        });
    journalEntry();
    // No longer in flight, however it ended; only an unseen turn deserves resuming. One whose record did not take it
    // stays journalled as settled, so a boot records it instead of running it again.
    const endJournal = (recorded: boolean): void => (recorded ? journal({ kind: "unjournalled" }) : journalEntry(true));
    // Restorable cards ride the journal entry while up (handovers excluded) and come off as each resolves, whoever raised
    // them: the turn itself through its frames, or a gate it called, pushing its card onto the run. Rewritten once the
    // frame is folded, so the rows it carries already show the card raised or settled.
    run.watch = (event) => {
        if (isRestorableRequest(event)) {
            parked.push(event);
            journalEntry();
            return;
        }
        const held = event.kind === "resolved" ? parked.findIndex((card) => card.requestId === event.requestId) : -1;
        if (held !== -1) {
            parked.splice(held, 1);
            journalEntry();
        }
    };
    // The log a restart records this run from, for a run the journal holds: what it opened on, then every patch.
    const runLog = journalled ? openLog?.({ run: run.id, startedAt: run.startedAt, rows: [...run.rows] }) : undefined;
    run.tap = runLog?.append;
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
    // Asks `route` for the turn the provider runs, once the run is claimed. A turn it moved to another provider or model is
    // said so in the log, and a journalled run's entry is written again with whatever it changed, so a restart resumes the
    // model and session it started on.
    const routed = async (): Promise<void> => {
        if (route === undefined) {
            return;
        }
        const accepted = input;
        // The turn as it was sent: the defaults `accepted` carries would read as a provider the turn chose.
        input = await route(sent);
        if (input.agent !== accepted.agent || input.model !== accepted.model) {
            deps.logger?.info(
                { conversationId: input.conversationId, run: run.id, provider: input.agent, ...opt("model", input.model === "" ? undefined : input.model) },
                "turn routed",
            );
        }
        if (input.agent !== accepted.agent || input.model !== accepted.model || input.sessionId !== accepted.sessionId) {
            journalEntry();
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
        // What that frame says of a re-run of this same turn the sandbox booked for itself, read with it at settle.
        let rerun: { readonly at?: number } | undefined;
        let stopped = false;
        try {
            await before;
            await routed();
            for await (const frame of turnFn(input, undefined)) {
                const event = kept(frame);
                // Every provider republishes its slash commands each turn; cache the latest (agent-commands.ts).
                if (event.kind === "commands") {
                    recordCommands(commandListOf(input.agent, input.harness), event.items);
                }
                // Frames that park the turn on the user; they keep the run's fetch open, so it still looks live.
                if (isParkKind(event.kind)) {
                    const awaiting = event.kind;
                    tell((target) => target.awaiting(awaiting));
                    // A person may be away for days: what the run drew up to its card goes to disk once it is folded.
                    queueMicrotask(() => void runLog?.flush());
                }
                // Session the provider minted, folded into the journal entry once known; a resume without it starts
                // over. Rewritten once the frame is folded.
                const rejournal = event.kind === "session";
                if (event.kind === "session") {
                    sessionId = event.sessionId;
                }
                if (event.kind === "error") {
                    failure = event.message;
                    rerun = bookedRerun(event);
                }
                run.push(event);
                if (rejournal) {
                    journalEntry();
                }
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
            expireRetained(deps, input.conversationId, run);
            // Durable transcript, written once the turn is whole, including a settled failure or an abort. Journal deletion
            // is the commit point, so the record goes first and a crash can't lose both. The log then goes, or is kept for
            // whoever writes the record next.
            const recorded = await writeSettled(run, transcript);
            await runLog?.close(recorded);
            try {
                endJournal(recorded);
            } finally {
                // Whatever the journal answered, so what waits on the record is never held for good.
                run.recordedNow();
            }
            const pulse = turnPulseOf(input.conversationId);
            const ours = pulse?.run === run.id ? pulse : undefined;
            deps.logger?.info(
                {
                    conversationId: input.conversationId,
                    run: run.id,
                    ...opt("turnId", ours?.turnId),
                    outcome: endingOf(run, stopped, failure),
                    durationMs: Math.max(0, Date.now() - run.startedAt),
                    ...opt("failure", failure?.slice(0, ENDED_FAILURE_CHARS)),
                    ...opt("rerunAt", rerun === undefined ? undefined : (rerun.at ?? "unscheduled")),
                    ...opt("upstreamStatus", ours?.upstream?.status),
                },
                "turn ended",
            );
            tell((target) => target.settled(failure === undefined ? { ok: true } : { ok: false, error: failure }));
            deps.events.publish("run.settled", settledOf(input, run.rows, { failure, stopped, rerun }));
        }
    })();
    return run;
}
