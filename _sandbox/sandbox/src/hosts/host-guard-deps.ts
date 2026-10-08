import type { SafetyVerdict } from "@intentic/sandbox-contract";
import type { judgeCommand } from "../agent/tools/command-judge.js";
import type { LiveRun } from "../conversations/actor/conversation-holdings.js";
import type { CardDeps } from "../guard/card-offers.js";
import type { HeldCards } from "../guard/held-cards.js";

// What the device gates (host-command-guard.ts, host-restart-guard.ts) take from above the host layer: the turn a call
// came from, the cards they raise in it, and the safety judge. app.ts fills it where it mounts the host peer, so hosts/
// imports none of conversations/ or agent/.
export interface HostGuardDeps {
    /** Where a gate's card lands and how its frames reach the conversation (conversations/actor/card-deps.ts). */
    readonly cards: Pick<CardDeps, "observe" | "cards" | "awaiting">;
    /** The conversation's turn as published, finished or not; undefined when it has none retained. */
    readonly turnRun: (conversationId: string) => LiveRun | undefined;
    /** Where a card the agent stopped waiting on is held for the turn's close (guard/held-cards.ts). */
    readonly held: Pick<HeldCards, "add">;
    /** The safety judge's verdict on one program (agent/tools/command-judge.ts). */
    readonly judge: (input: Parameters<typeof judgeCommand>[2], signal: AbortSignal) => Promise<SafetyVerdict>;
}
