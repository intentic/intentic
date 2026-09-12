import type { AgentChangesResponse } from "@intentic/api-contract";
import type { AgentSpan, AgentSummary, LandMode, LandResult } from "@intentic/sandbox-contract";
import { useDevice } from "@intentic/ui";
import type { Conversation } from "../../chat/session/conversation";
import { summonChat } from "../../chat/run/summon";
import { useChat } from "../../chat/run/useChat";
import { composingConversation, draftConversation } from "../../chat/panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { router } from "../../../router";
import { refreshAcross } from "../../sandbox/live/fleetAcross";
import { refreshChangesAcross } from "../../workspace/changes/changesAcross";
import { type RequestOptions, sandboxJson, sandboxJsonAt } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { agentBlockers, blockersOf, resolvePrompt, userBlockers } from "../review/conflictResolution";
import type { FleetAgent } from "./useAgents-fleet";
import { useAgents } from "./useAgents";
import { AGENT_DIFF, GIT_CHANGES, HISTORY_SNAPSHOTS } from "../../../lib/queryKeys";

// The fleet's mutations, addressed by agent id: the shared source for the review panel's bindings and the board's
// drag-to-act drops. Land and discard are refused daemon-side while the agent's turn is running, since the worktree is
// that turn's live working state.

// Threaded through every mutation as a trailing optional argument: undefined means the active sandbox, a value means
// the wider board acting on another box's card. Every mutation crosses except `askAgentToResolve`, which sends a
// message through the chat singleton and so never will.
export type AgentReach = string | undefined;

const agentJson = <T>(at: AgentReach, path: string, init?: RequestInit, options?: RequestOptions): Promise<T> =>
    at === undefined ? sandboxJson<T>(path, init, options) : sandboxJsonAt<T>(at, path, init, options);

// Routes to the active sandbox, or to a named one, matching `at`.
export const startAgent = (prompt?: string, actsAs?: string): string => {
    const conversation = draftConversation();
    // "New agent", as one action across every surface (board button, chat strip's +, mobile +): summon the tab in every
    // window, put the caret in its composer, and on mobile navigate to it. A press over an untouched draft reuses it
    // instead of minting a second one.
    conversation.actsAs.value = actsAs;
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
    if (prompt !== undefined) {
        void conversation.enqueue(prompt);
    }
    return conversation.conversationId;
};

// Same press as startAgent but without the send: a suggestion the user hasn't read isn't a task they asked for, so the
// text stays in the composer, editable. Writes into the focused chat when nothing's been sent there, so a second
// suggestion replaces the first rather than opening a new tab.
export const composeAgent = (prompt: string): void => {
    const conversation = composingConversation();
    conversation.draft.value = prompt;
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
};

// The navigation half of a summons: mobile has no docked panel, so the agent's own screen is where the summoned chat
// shows. Local only, since a background window navigating itself would yank the route from under whoever returns to it.
export const revealConversation = (conversation: Conversation): void => {
    if (useDevice().mobile.value) {
        void router.push(`/agents/${encodeURIComponent(conversation.conversationId)}`);
    }
};

// The open conversation with this id, or none; exported for the one caller that needs it before a conversation exists
// (sessionSuggestion.ts), so it derives the same id rather than minting a second daemon session.
export const openConversation = (id: string): Conversation | undefined =>
    useChat().conversations.value.find((candidate) => candidate.conversationId === id);

// Land: carries the agent's worktree branches into main; a conflict refuses every write. `span: cumulative` re-reads
// from the branch's base for work already landed then discarded; `force` overrides the turn guard and must come only
// from a press that showed the warning first.
// No headers deadline: the answer comes once the work is in the tree, and a large delta takes longer than the bound;
// the card's `landing` status carries the wait, so a request given up on would only re-enable a press the daemon
// refuses.
export const landAgent = (
    id: string,
    mode: LandMode = `check`,
    span: AgentSpan = `outstanding`,
    force = false,
    at: AgentReach = undefined,
): Promise<LandResult> =>
    agentJson<LandResult>(at, `/agents/${encodeURIComponent(id)}/land`, jsonBody(`POST`, { mode, span, force }), { deadline: false });

// A collaborator's stand-in for a land they can't perform (the daemon floors `land` at maintainer): stamps the ask so
// every maintainer's board wears it.
export const requestLandAgent = (id: string, at: AgentReach = undefined): Promise<AgentSummary> =>
    agentJson<AgentSummary>(at, `/agents/${encodeURIComponent(id)}/request-land`, jsonBody(`POST`, {}));

// Hands a land conflict back to the agent to resolve in its own worktree, rather than making the user merge by hand or
// discarding the work. An ordinary turn: it lands in the transcript, a running turn takes it as steering, and Stop
// works on it like any other.

// Whether the turn actually went, and, if not, the one sentence explaining why, so callers can't invent their own
// wording.
export type ResolveAsk = { readonly sent: true } | { readonly sent: false; readonly why: string };

export const askAgentToResolve = async (id: string): Promise<ResolveAsk> => {
    const { agentById, open } = useAgents();
    const agent = agentById(id);
    if (agent !== undefined) {
        open(agent);
    }
    const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === id);
    // A registered agent always has a tab by now (`open()` just made one); an unknown card has no conversation to send
    // to.
    if (conversation === undefined) {
        return { sent: false, why: `That agent has no conversation left to send to.` };
    }
    const { conflicts } = await sandboxJson<AgentChangesResponse>(`/agents/${encodeURIComponent(id)}/diff`);
    // Refusing is not a send: the report is re-derived fresh at read time so a stale refusal can't reappear. The user's
    // own uncommitted edits are the one thing a rebase can't reach, so they're named explicitly rather than sent to the
    // agent as a task.
    const blockers = blockersOf(conflicts);
    if (agentBlockers(blockers).length === 0) {
        const yours = userBlockers(blockers).length;
        return {
            sent: false,
            why:
                yours > 0
                    ? `A rebase can't reach this: ${yours === 1 ? `the blocked file is` : `all ${yours} blocked files are`} held by your own uncommitted edits. Commit or stash them, then land again.`
                    : `Nothing left for the agent to rebase, open it to see what the land reported.`,
        };
    }
    // The app composed this turn, so it runs as the agent, not on whatever the composer in THIS window happens to hold:
    // a tab minted from a history row or a second window carries the last pick made there, and a turn sent on it both
    // spends against a model the user never chose for this agent and relabels the card with it afterwards.
    wearAgentModel(conversation, agent);
    // Dispatched, not awaited: `enqueue` doesn't settle until the turn does, and awaiting it here would hold the
    // caller's busy flag across a multi-minute rebase.
    void conversation.enqueue(resolvePrompt(conflicts));
    return { sent: true };
};

// What the agent's own turns ran on, as the registry recorded them. Absent for an agent that has never run one, which
// leaves the tab's picks alone — there is nothing better to put there.
const wearAgentModel = (conversation: Conversation, agent: FleetAgent | undefined): void => {
    if (agent?.model === undefined || agent.model === ``) {
        return;
    }
    conversation.wearModel({
        provider: agent.provider,
        model: agent.model,
        harness: agent.harness,
        ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
        ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
    });
};

// Discard: drop the worktrees, the agent/<id> branches, and the registry entry. Irreversible.
export const discardAgent = async (id: string, at: AgentReach = undefined): Promise<void> => {
    await agentJson(at, `/agents/${encodeURIComponent(id)}/discard`, { method: `POST` });
};

// True cancel for an in-flight turn: an open streaming tab runs its own stop() path; otherwise post the cancel straight
// to the daemon. A card in another box never takes the local branch, since the same id can exist in two sandboxes.
export const stopAgent = async (id: string, at: AgentReach = undefined): Promise<void> => {
    const { conversations } = useChat();
    const conversation = at === undefined ? conversations.value.find((candidate) => candidate.conversationId === id) : undefined;
    if (conversation !== undefined && conversation.streaming.value) {
        conversation.stop();
        return;
    }
    await agentJson(at, `/agent/stop`, jsonBody(`POST`, { conversationId: id }));
};

// After a land or discard, invalidate the agent's diff plus the workspace-wide changes and history caches so every
// surface converges. The two workspace families use `.every` since a land in another box changes that box's own
// `/work`.
export const invalidateAgentAction = async (id: string, at: AgentReach = undefined): Promise<void> => {
    if (at !== undefined) {
        refreshAcross();
        // ...and the changes ledger too: landing into another box's /work is exactly what moves its uncommitted count.
        refreshChangesAcross();
    }
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: at === undefined ? AGENT_DIFF.of(id) : AGENT_DIFF.ofSandbox(at, id) }),
        queryClient.invalidateQueries({ queryKey: GIT_CHANGES.every }),
        queryClient.invalidateQueries({ queryKey: HISTORY_SNAPSHOTS.every }),
    ]);
};
