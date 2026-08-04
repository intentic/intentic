import type { Loop, LoopRecord } from "@intentic/sandbox-contract";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";

/* THE LOOP MUTATIONS, and deliberately nothing else.
 *
 * There is no store here and no query, because a running loop has nothing for one to hold: where the loop
 * stands rides on the fleet roster (AgentSummary.loop), which the /events stream already pushes into useAgents
 * about once a second. A second source polling /loops for the same three numbers could only ever disagree with
 * the card next to it.
 *
 * `history` is the one read, and it is on demand — the iteration list is what an ENDED loop is opened for, and
 * nothing renders it until someone asks.
 */

// Start looping a conversation. Resolves with the record as the daemon wrote it; the loop itself runs detached,
// and the fleet card is where it is watched.
export const startLoop = (loop: Loop): Promise<LoopRecord> => sandboxJson<LoopRecord>(`/loops`, jsonBody(`POST`, loop));

// Ask the loop to stop after the iteration in flight. Explicitly NOT a turn abort — the work running right now
// finishes and lands. Throwing Stop at the turn as well is `stopAgentTurn`, and pressing both is how a user
// abandons a loop outright.
export const stopLoop = (conversationId: string): Promise<void> =>
    sandboxJson(`/loops/${encodeURIComponent(conversationId)}/stop`, { method: `POST` }).then(() => undefined);

// Every loop this workspace has run, newest first — read when a surface wants the iteration history behind a
// card's one-line verdict.
export const loopHistory = async (): Promise<readonly LoopRecord[]> => (await sandboxJson<{ loops: LoopRecord[] }>(`/loops`)).loops;
