import type { LandResult } from "@intentic/sandbox-contract";
import { useDevice } from "@intentic-app/ui";
import { focusComposer, useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { router } from "../../router";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";

/* The fleet's mutations, addressed by agent id — the true source for both surfaces that invoke them: the
 * review panel (useAgentChanges, which binds one agent to its diff query) and the board's drag-to-act drops,
 * which act on whichever card was dropped and own no query at all. Land and discard are refused daemon-side
 * while the agent's turn is running: the worktree is that turn's live working state. */

// "New agent", as ONE action for every surface that offers it: the board's header button and its empty state,
// the chat strip's "+", and the mobile strip's "+". They all mean the same thing — a fresh isolated
// conversation, focused and ready to type into — so they must all do the same thing, whole. That is three
// steps, and a surface that skips any of them reads as a press that did nothing:
//   · open the tab (the fleet's draft card and the chat's tab are the same conversation under two skins)
//   · put the caret in its composer, which is what makes the new tab visible as the thing you now type into
//   · on mobile, go to it — there is no docked chat there, so the agent's own screen IS the result (and a "+"
//     pressed from an agent's screen would otherwise leave the route pointing at the agent you just left)
export const startAgent = (): void => {
    const { newChat } = useChat();
    const conversation = newChat();
    focusComposer();
    if (useDevice().mobile.value) {
        void router.push(`/agents/${encodeURIComponent(conversation.conversationId)}`);
    }
};

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
