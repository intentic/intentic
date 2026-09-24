import type { MessageReceipt, TurnProfile } from "@intentic/sandbox-contract";
import { opt } from "../../../opt.js";
import type { SteerVoice, TurnStarter, Unsaid } from "../../../seams/turn-starter.js";

// The one door for words nobody at a conversation's composer typed: said into its live turn where that turn takes them,
// a turn of their own when nothing runs, and otherwise queued behind whatever the conversation is doing, where every
// window sees them until they go.

export interface Wake {
    readonly conversationId: string;
    readonly prompt: string;
    readonly voice: Exclude<SteerVoice, "person">;
    // The source of outside content in the prompt; whatever turn it reaches is tainted by it.
    readonly outside?: string;
    // The turn the wake continues, whole; conversation, prompt, session and taint are the wake's own.
    readonly profile: TurnProfile;
}

// The port's door a wake takes, and where it reads the session a turn of its own continues.
export interface WakeDoors {
    readonly turns: Pick<TurnStarter, "say">;
    readonly sessionIdOf: (conversationId: string) => string | undefined;
}

/** Hands the wake to its conversation, answered with where it went; one that waits goes once the conversation is free. */
export const deliverWake = (doors: WakeDoors, wake: Wake): Promise<MessageReceipt | Unsaid> =>
    doors.turns.say({
        voice: wake.voice,
        ...opt("outside", wake.outside),
        turn: {
            ...wake.profile,
            conversationId: wake.conversationId,
            prompt: wake.prompt,
            ...opt("sessionId", doors.sessionIdOf(wake.conversationId)),
        },
    });
