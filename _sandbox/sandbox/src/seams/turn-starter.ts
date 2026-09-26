import type {
    AgentEvent,
    AgentHarness,
    AgentProvider,
    AgentReply,
    AgentTurn,
    EditorContext,
    MessageReceipt,
    MessageVoice,
    QueuedMessageRef,
    QueueEdit,
    QueueResume,
    QueueResumed,
    ResumeReason,
    ResumeRouting,
    SessionOwner,
    StopResult,
    StopTurn,
    TurnErrand,
    TurnSpeaker,
} from "@intentic/sandbox-contract";
import type { BeginRefusal } from "../conversations/actor/conversation-decide.js";
import type { QueueChange } from "../conversations/actor/conversation-queue.js";

// How a subsystem starts or drives a conversation's turn without importing the turn engine: it names this port in its
// deps, and composition hands it the engine's own implementation (agent/run/turn/turn-doors.ts).

/* WHO ASKED FOR THIS TURN, as the daemon verified it, never as the client said it. */
export type TurnInput = AgentTurn & {
    // Who is speaking (seams/turn-speaker.ts); `actor` and `owner` are derived from it at the door that built it.
    readonly speaker?: TurnSpeaker;
    readonly actor?: string;
    // The member the conversation belongs to if this turn is its first; `since` is the registry's to stamp.
    readonly owner?: Pick<SessionOwner, "email" | "name">;
    // The fence its starter holds, as area ids, if this turn is its first; latched there and never re-read, or an
    // unfenced person replying in a fenced conversation would widen it mid-thread.
    readonly areas?: readonly string[];
    // Runs the door turned away before this turn sent the same words again: recorded, never seen by the model, so no
    // history for a session seeded from the record.
    readonly unseenRuns?: readonly string[];
    // Which re-run this turn is, set where the re-run is made; its prompt opens with the matching note for the model.
    readonly resume?: ResumeReason | undefined;
};

// A turn as the engine takes it: provider and loop named, by the port it came in through (withRuntimeDefaults), so
// nothing past the door defaults them again.
export type RoutedTurn<T extends TurnInput = TurnInput> = T & { readonly agent: AgentProvider; readonly harness: AgentHarness };

// Who is speaking into a live turn; only a person proves somebody is at the composer.
export type SteerVoice = "person" | "sandbox" | "agent";

export interface Steer {
    readonly text: string;
    readonly voice: SteerVoice;
    // The source of outside content in these words; the live turn is tainted by it as they land.
    readonly outside?: string;
    // What composed words are for (schemas/speaker.ts), which the row they become carries.
    readonly errand?: TurnErrand | undefined;
    // A person's references, composed into the words against this workspace before they land.
    readonly attachments?: readonly string[] | undefined;
    readonly mentions?: readonly string[] | undefined;
    readonly editorContext?: EditorContext | undefined;
    // The id its sender gave the message, which its row carries; the sandbox names one when the sender gave none.
    readonly messageId?: string | undefined;
}

// Why a person's words reached no turn: none that takes words is live (`why` says which way), or a reference escapes the
// workspace (`invalid` names it).
export type Unsteered = { readonly why: string } | { readonly invalid: string };

// Why words went nowhere, not even the queue: a reference escapes the workspace (`invalid` names it), or the conversation
// is archived and they are not a person's (`why` says so).
export type Unsaid = { readonly invalid: string } | { readonly why: string };

// Words for a conversation from whoever speaks, and the turn they start should they start one.
export interface Said {
    // The words and who serves their turn, as the sender named them; `messageId` is theirs, or the sandbox names one.
    readonly turn: TurnInput & { readonly conversationId: string };
    readonly voice: MessageVoice;
    // The source of outside content in the words; whatever turn they reach is tainted by it.
    readonly outside?: string | undefined;
}

// A detached run as its starter holds it: which run it is, and its frames from the moment this is read.
export interface StartedRun {
    readonly id: string;
    readonly frames: () => AsyncGenerator<AgentEvent>;
}

export interface StartOptions {
    // How many boots already re-ran this turn; set only by the boot pass.
    readonly attempts?: number;
    // A person's words, which the conversation's queue takes back for another press when the door refuses them. Every
    // other start is the sandbox's own (a fix press, a peer's message, a re-run), so the sandbox is the only keeper a
    // refusal leaves.
    readonly senderKeeps?: boolean;
}

export interface TurnStarter {
    // The detached start every daemon-started turn takes: journalled, recorded, announced; the refusal instead while a
    // turn already runs on the conversation, or while it is archived. Whoever starts a turn on a person's say-so reopens
    // an archived conversation first (`agents.clearArchived`), at the door that carries their words.
    readonly start: (turn: TurnInput & { readonly conversationId: string }, options?: StartOptions) => Promise<StartedRun | BeginRefusal>;
    // Re-runs the turn a wall holds for the conversation, re-routed where `routing` names it; undefined when none is held
    // or its start was refused.
    readonly resume: (conversationId: string, routing?: ResumeRouting) => Promise<StartedRun | undefined>;
    // A detached run its starter reads, recorded to the conversation but neither journalled, pinned nor announced: a
    // loop keeps those books itself.
    readonly run: (turn: TurnInput & { readonly conversationId: string }) => StartedRun | BeginRefusal;
    // The turn itself, for a caller folding its own frames (an automation's fire, a runner's dispatched turn).
    readonly stream: (turn: TurnInput, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;
    // Words into the live turn: `invalid` names a reference escaping the workspace, false means no steerable turn.
    readonly steer: (conversationId: string, steer: Steer) => Promise<boolean | { readonly invalid: string }>;
    // Words said into the live turn, a turn of their own, or queued for the next; one message id twice gets the first
    // answer back, and nobody's words reach an archived conversation (a person's door reopens it first).
    readonly say: (said: Said) => Promise<MessageReceipt | Unsaid>;
    // A person's message into the live turn and nowhere else, drawn as their row and answered the same way.
    readonly steerIn: (conversationId: string, steer: Omit<Steer, "voice" | "outside">) => Promise<MessageReceipt | Unsteered>;
    // Lets out what waits in the conversation's queue, as far as anything can take it now.
    readonly drain: (conversationId: string) => Promise<void>;
    // Changes to what waits, each refused as stale when the message changed since it was read.
    readonly unqueue: (ref: QueuedMessageRef) => Promise<QueueChange>;
    readonly reword: (edit: QueueEdit) => Promise<QueueChange>;
    // Lets a held queue go, re-routed where the press names who serves it.
    readonly release: (resume: QueueResume) => Promise<QueueResumed>;
    // An answer to a card some turn is parked on: `missing` for no such card, `refused` for one addressed elsewhere.
    readonly reply: (reply: AgentReply) => Promise<"settled" | "missing" | { readonly refused: string }>;
    // Hard-cancels the named run, or whatever is live for a caller that cannot name one, and returns once it has
    // unwound; a named run that is no longer the live one is left alone, and the answer names the one running instead.
    readonly stop: (target: StopTurn) => Promise<StopResult>;
}
