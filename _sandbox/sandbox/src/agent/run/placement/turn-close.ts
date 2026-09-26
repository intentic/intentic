import type { Logger } from "pino";
import { awaitingWake } from "../../../conversations/actor/conversation-state.js";
import type { ConversationActors } from "../../../conversations/actor/conversation-actors.js";
import type { ListeningPort } from "../../../ports/port-scan.js";
import type { SteeringQueue } from "../../checkpoints/agent-steering.js";
import { adoptBackgroundJobs } from "../../tools/jobs/background-adoption.js";
import { resolveTurnJobs } from "../../tools/jobs/job-fates.js";

// THE TURN'S CLOSE, in the one order it runs (placedTurn, turn-placement.ts, drives it), however the turn ended:
// 1. hush: the body has ended, so words said from here (a person's, a wake that fires now) wait in the conversation's
//    queue for the next turn instead of going into a steering queue no model reads any more.
// 2. judge jobs: each job the run left running is stopped, left to the person, or awaited (job-fates.ts); once per run.
// 3. arm wakes: each awaited job, and each finished one whose exit the model never read, is handed to a watch
//    (background-adoption.ts). What the conversation holds then says whether it runs again by itself (awaitingWake,
//    conversation-state.ts), so nothing later predicts it.
// 4. land, a turn that ended clean only (placement.land): nothing while it awaits a wake, whose turn finishes the work;
//    else the repository's own fixers run in its worktree (worktree-fixers.ts), the rules decide, and it lands under the
//    lease (turn-landing.ts).
// 5. settle: the placement's books, then the conversation's actor.
// 6. publish, once: the placement announces how the turn ended (TurnEnding).
// The run registry announces `run.settled` after all of it; its listeners are independent of each other and of this
// order (docs/subsystems.md).

// How a turn ended, as its close decided it: an error, a stop, waiting on a wake it armed, or finished.
export type TurnEnding = "failed" | "stopped" | "awaiting-wake" | "finished";

// Steps 1 to 3, bound to one conversation's turn; placedTurn runs them once, before its land or in its finally.
export interface TurnCloser {
    readonly hush: () => void;
    // Answers whether the conversation now awaits a wake.
    readonly armWakes: () => Promise<boolean>;
}

export interface TurnCloserDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "send" | "state">;
    readonly scanPorts: () => Promise<readonly ListeningPort[]>;
    readonly logger: Logger;
}

export const turnCloser = (deps: TurnCloserDeps, conversationId: string, steering: SteeringQueue | undefined): TurnCloser => ({
    hush: () => steering?.close(),
    armWakes: async () => {
        await resolveTurnJobs(deps, conversationId);
        // A job that exited before its watch armed wakes the conversation at once: a wake already on its way.
        const handed = await adoptBackgroundJobs(deps.conversations, conversationId, deps.logger);
        const state = deps.conversations.state(conversationId);
        return handed > 0 || (state !== undefined && awaitingWake(state));
    },
});
