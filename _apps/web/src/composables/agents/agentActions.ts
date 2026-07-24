import type { LandResult } from "@intentic/sandbox-contract";
import { useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";

/* The fleet's mutations, addressed by agent id — the true source for both surfaces that invoke them: the
 * review panel (useAgentChanges, which binds one agent to its diff query) and the board's drag-to-act drops,
 * which act on whichever card was dropped and own no query at all. Land and discard are refused daemon-side
 * while the agent's turn is running: the worktree is that turn's live working state. */

// Land: merge the agent's worktree branches into the main tree. A partial result reports per-repo conflicts —
// the worktree keeps everything, so the user can resolve (main-side), discard, or keep working.
export const landAgent = (id: string): Promise<LandResult> => sandboxJson<LandResult>(`/agents/${encodeURIComponent(id)}/land`, { method: `POST` });

// Discard: drop the worktrees, the agent/<id> branches, and the registry entry. Irreversible.
export const discardAgent = async (id: string): Promise<void> => {
    await sandboxJson(`/agents/${encodeURIComponent(id)}/discard`, { method: `POST` });
};

// True cancel for an in-flight turn. An open, streaming tab owns the local transcript, so its own stop() runs
// the whole path (muted "Stopped." notice → /agent/stop → abort the stream); a card whose conversation this
// browser never opened has no tab to speak for it, so post the cancel straight to the daemon.
export const stopAgent = async (id: string): Promise<void> => {
    const { conversations } = useChat();
    const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
    if (conversation !== undefined && conversation.streaming.value) {
        conversation.stop();
        return;
    }
    await sandboxJson(`/agent/stop`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ conversationId: id }),
    });
};

// After a land or discard the agent's diff changed AND the landed work now shows in the MAIN review +
// history — invalidate all three so every surface converges. Three disjoint caches, no ordering.
export const invalidateAgentAction = async (id: string): Promise<void> => {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: sandboxKey(`agents`, id, `diff`) }),
        queryClient.invalidateQueries({ queryKey: [`git`, `changes`] }),
        queryClient.invalidateQueries({ queryKey: [`history`, `snapshots`] }),
    ]);
};
