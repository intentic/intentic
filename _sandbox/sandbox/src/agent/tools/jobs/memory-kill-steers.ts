import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import { steerTurn } from "../../checkpoints/agent-steering.js";

/* KILLS TOLD TOGETHER (2026-11-17, the shinobi-society audit). The memory guard and the kernel kill in bursts: seven kills
   in two minutes reached one turn as seven notices, each its own steer, and each cut the agent's wait short to read one
   line. So the follower (memory-kills.ts) hands each kill's words here, and a conversation hears every kill of a short
   window in ONE steer, said once the window after its first kill closes. Activity still gets one entry per kill: the
   editor shows each. */

/** How long after a conversation's first kill the steer waits for more before it is said. */
const KILL_STEER_WINDOW_MS = 4_000;

export interface KillSteers {
    // One kill's words for a conversation, said with whatever else the window collects.
    readonly add: (conversationId: string, said: string) => void;
    // Says everything held now: the follower stopping leaves nothing untold.
    readonly flush: () => void;
}

// One kill as said alone, several as one list under a line that counts them.
export const steerText = (said: readonly string[]): string =>
    said.length === 1 ? (said[0] ?? "") : [`${String(said.length)} processes this conversation started were killed for memory:`, ...said.map((line) => `- ${line}`)].join("\n");

export const killSteers = (conversations: Pick<ConversationActors, "steer" | "send" | "holdings">, windowMs = KILL_STEER_WINDOW_MS): KillSteers => {
    const held = new Map<string, { readonly said: string[]; readonly timer: NodeJS.Timeout }>();
    const say = (conversationId: string): void => {
        const batch = held.get(conversationId);
        if (batch === undefined) {
            return;
        }
        held.delete(conversationId);
        clearTimeout(batch.timer);
        // Into the live turn, between two tool calls, as the sandbox's words: a turn at rest is never started for it.
        steerTurn(conversations, conversationId, { text: steerText(batch.said), voice: "sandbox" });
    };
    return {
        add: (conversationId, said) => {
            const batch = held.get(conversationId);
            if (batch !== undefined) {
                batch.said.push(said);
                return;
            }
            const timer = setTimeout(() => say(conversationId), windowMs);
            timer.unref();
            held.set(conversationId, { said: [said], timer });
        },
        flush: () => {
            // Deleting the entry being visited is safe in a Map's iteration.
            for (const conversationId of held.keys()) {
                say(conversationId);
            }
        },
    };
};
