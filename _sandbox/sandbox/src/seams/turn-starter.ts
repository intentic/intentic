import type { AgentEvent, AgentReply, AgentTurn, EditorContext, ResumeRouting, SessionOwner } from "@intentic/sandbox-contract";

// How a subsystem starts or drives a conversation's turn without importing the turn engine: it names this port in its
// deps, and composition hands it the engine's own implementation (agent/run/turn/turn-doors.ts).

/* WHO ASKED FOR THIS TURN, as the daemon verified it, never as the client said it. */
export type TurnInput = AgentTurn & {
    readonly actor?: string;
    // The member the conversation belongs to if this turn is its first; `since` is the registry's to stamp.
    readonly owner?: Pick<SessionOwner, "email" | "name">;
    // The fence its starter holds, as area ids, if this turn is its first; latched there and never re-read, or an
    // unfenced person replying in a fenced conversation would widen it mid-thread.
    readonly areas?: readonly string[];
    // Runs the door turned away before this turn sent the same words again: recorded, never seen by the model, so no
    // history for a session seeded from the record.
    readonly unseenRuns?: readonly string[];
};

// Who is speaking into a live turn; only a person proves somebody is at the composer.
export type SteerVoice = "person" | "sandbox" | "agent";

export interface Steer {
    readonly text: string;
    readonly voice: SteerVoice;
    // The source of outside content in these words; the live turn is tainted by it as they land.
    readonly outside?: string;
    // A person's references, composed into the words against this workspace before they land.
    readonly attachments?: readonly string[];
    readonly mentions?: readonly string[];
    readonly editorContext?: EditorContext;
}

// A detached run as its starter holds it: which run it is, and its frames from the moment this is read.
export interface StartedRun {
    readonly id: string;
    readonly frames: () => AsyncGenerator<AgentEvent>;
}

export interface StartOptions {
    // How many boots already re-ran this turn; set only by the boot pass.
    readonly attempts?: number;
    // The words came through POST /agent, whose composer keeps them for another press. Every other start is the
    // sandbox's own (a fix press, a peer's message, a re-run), so the sandbox is the only keeper a refusal leaves.
    readonly senderKeeps?: boolean;
}

export interface TurnStarter {
    // The detached start every daemon-started turn takes: journalled, recorded, announced; undefined while a turn
    // already runs on the conversation.
    readonly start: (turn: TurnInput & { readonly conversationId: string }, options?: StartOptions) => Promise<StartedRun | undefined>;
    // Re-runs the turn a wall holds for the conversation, re-routed where `routing` names it; undefined when none is held.
    readonly resume: (conversationId: string, routing?: ResumeRouting) => Promise<StartedRun | undefined>;
    // A detached run its starter reads, recorded to the conversation but neither journalled, pinned nor announced: a
    // loop keeps those books itself.
    readonly run: (turn: TurnInput & { readonly conversationId: string }) => StartedRun | undefined;
    // The turn itself, for a caller folding its own frames (an automation's fire, a runner's dispatched turn).
    readonly stream: (turn: TurnInput, signal: AbortSignal | undefined) => AsyncGenerator<AgentEvent>;
    // Words into the live turn: `invalid` names a reference escaping the workspace, false means no steerable turn.
    readonly steer: (conversationId: string, steer: Steer) => Promise<boolean | { readonly invalid: string }>;
    // An answer to a card some turn is parked on: `missing` for no such card, `refused` for one addressed elsewhere.
    readonly reply: (reply: AgentReply) => Promise<"settled" | "missing" | { readonly refused: string }>;
    // Hard-cancels the live turn and returns once its run has unwound; false when nothing was running.
    readonly stop: (conversationId: string) => Promise<boolean>;
}
