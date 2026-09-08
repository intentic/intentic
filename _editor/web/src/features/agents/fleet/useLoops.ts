import type { Loop, LoopRecord } from "@intentic/sandbox-contract";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";

// Loop mutations only. Loop state rides the fleet roster's `AgentSummary.loop` via the `/events` stream, not a
// separate store or query.

// Starts looping; resolves with the daemon's written record while the loop itself runs detached, watched via the
// fleet card.
export const startLoop = (loop: Loop): Promise<LoopRecord> => sandboxJson<LoopRecord>(`/loops`, jsonBody(`POST`, loop));

// Stops the loop after the iteration in flight, not a turn abort. Aborting a loop outright needs both this and
// `stopAgentTurn`.
export const stopLoop = (conversationId: string): Promise<void> =>
    sandboxJson(`/loops/${encodeURIComponent(conversationId)}/stop`, { method: `POST` }).then(() => undefined);
