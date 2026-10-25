import type { AgentOrigin } from "@intentic/sandbox-contract/schemas/agent";
import type { ListenerPlanItem, ListenerStep, ListenerTurnOpened } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { SenderLane } from "../senders.js";
import type { JournalledFire } from "../../store/journals/turn-journal.js";

// Live sink for a turn's assistant text; undefined means the agent sends its own reply. `failed` distinguishes no
// output from an error, carrying the raw reason for each sink to redact; always followed by `end`. The rest is what a
// channel can show while it waits, each optional, so a sink that only takes the reply's text (the Visitor chat) still
// fits: the turn it opened, each step of its work and its checklist (extensions/listener/listener-progress.ts), and why it has not started.
export interface TurnStream {
    readonly delta: (text: string) => void;
    readonly failed: (reason: string) => void;
    readonly end: () => void;
    readonly opened?: (turn: ListenerTurnOpened) => void;
    readonly step?: (step: ListenerStep) => void;
    readonly plan?: (items: readonly ListenerPlanItem[]) => void;
    readonly held?: (reason: string) => void;
    readonly queued?: (reason: string) => void;
    // The message went into a turn already running in its thread; that turn's own sink carries the answer.
    readonly steered?: () => void;
}

// Everything a fire needs beyond the automation itself; an options object since dispatchers and the tick each set a
// different subset.
export interface FireOptions {
    readonly inboxIds?: readonly string[];
    readonly admission?: JournalledFire;
    // Inbox-to-journal handoff; acknowledged only after the admission is durable.
    readonly accepted?: () => Promise<void>;
    // The trigger's payload, appended to the prompt and handed to the guard as AUTOMATION_PAYLOAD.
    readonly payload?: string;
    // Which pre-wake gate this fire already satisfies, so it is not put through again:
    // - `approval`: the owner clicked Run now, or a restart is re-firing a wake already past the gate; the guard still
    //   runs.
    // - `both`: replaying a held wake whose guard already ran and passed.
    readonly cleared?: "approval" | "both";
    // How many times a boot re-fired this wake, so one that keeps dying isn't re-fired forever. First fire is 0.
    readonly attempts?: number;
    // Set by the restart path or a dispatcher owning a thread, so repeated messages share one conversation.
    readonly conversationId?: string;
    // Provider session the conversation last ran on; meaningful only alongside conversationId.
    readonly sessionId?: string;
    // The thread-sessions key this fire belongs to, snapshotted on a hold so the approved run settles the same thread.
    readonly thread?: string;
    // What the sender's rule decided (senders.ts): present, its persona replaces the automation's and its hold adds to
    // it. Absent for a fire nobody sent, a schedule or a webhook, which wears the automation's own.
    readonly lane?: SenderLane;
    // Replaces the automation's own `allowedTools` for this one fire. Every fire already carries the automation's list
    // (runFire reads it off the record), whichever door it came through, so this is only for a caller that must differ.
    readonly allowedTools?: readonly string[];
    // When set, text deltas stream here live and the agent is told (STREAM_NOTE) not to send the reply itself.
    readonly stream?: TurnStream;
    // Set by dispatchers on an outside message; provenance only, for the board and guard layer, not where it runs.
    readonly origin?: AgentOrigin;
    // Card/tab title, since the prompt repeats across fires and can't tell two apart; derived below if absent.
    readonly title?: string;
    // Said under the prompt when this fire is a schedule's moment the sandbox slept through (the catch-up at start), so
    // a nightly chore run at noon knows it is late. Its own section rather than the payload: a gated schedule's payload
    // is its sessions listing, which a guard reads, and this note is for the agent only.
    readonly late?: string;
    // What the automation's check saw, already worded for the wake: carried by a held wake's replay, whose check ran
    // when it was held and must not run again (it would compare against the value it just recorded).
    readonly observed?: string;
    // The held wake this fire replays, by id: what a delivery into a conversation is keyed on, so two holds approved
    // together are two deliveries rather than one answered twice.
    readonly held?: string;
    // What happens when this fire meets one it has to wait for (FireLanes): any fire of its automation, for a fire that
    // runs alone; a fire running alone or one on its own conversation, for a thread's. Every thread slot being taken is
    // not an overlap, and always queues.
    // - `drop` (default): a cron or workspace-event re-fire is not wanted twice; the next tick comes anyway.
    // - `queue`: for an inbound message with no next tick; waits for the run in progress, keeping its reply sink open.
    readonly overlap?: "drop" | "queue";
}

// What a fire leaves for a caller running another one on the same conversation: the provider session to resume, absent
// when no turn ran or none was minted.
export interface FireOutcome {
    readonly sessionId?: string;
}

// Where a fire's conversation comes from when it may belong to a thread (sessions/thread-sessions.ts), the key of which
// also keys the lane (seams/thread-key.ts):
// - an opening: a message arriving now. It continues the thread's live conversation and provider session, or past the
//   TTL starts one named by `mint`; each door names its own (a listener per fire, a public door per caller).
// - a seat: one already opened and snapshotted, by a held wake or the turn journal, continued exactly as it was. A seat
//   with no key is a fire no thread owns, a schedule's or a webhook's.
export type ThreadPlace =
    | { readonly key: string; readonly ttlMs: number; readonly mint: () => string }
    | { readonly key: string | undefined; readonly conversationId: string | undefined; readonly sessionId: string | undefined };

// Fire options a thread decides for itself, so a caller cannot hand one that disagrees with the thread.
export type ThreadFireOptions = Omit<FireOptions, "conversationId" | "sessionId" | "thread">;
