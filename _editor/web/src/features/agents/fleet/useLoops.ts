import type { Loop, LoopRecord } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";

// Loop mutations only. Loop state rides the fleet roster's `AgentSummary.loop` via the `/events` stream, not a
// separate store or query.

// Starts looping; resolves with the daemon's written record while the loop itself runs detached, watched via the
// fleet card.
export const startLoop = (loop: Loop): Promise<LoopRecord> => sandboxRpc.loops.start(loop);

// Stops the loop after the iteration in flight, not a turn abort. Aborting a loop outright needs both this and
// `stopAgentTurn`.
export const stopLoop = (conversationId: string): Promise<void> => sandboxRpc.loops.stop({ conversationId }).then(() => undefined);
