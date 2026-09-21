import type { AgentChangesResponse } from "@intentic/api-contract";
import type { AgentSpan, AgentSummary, LandMode, LandResult } from "@intentic/sandbox-contract";
import { useDevice } from "@intentic/ui";
import type { Conversation } from "../../chat/session/conversation";
import { summonChat, summonTurn } from "../../chat/run/summon";
import { useChat } from "../../chat/run/useChat";
import { composingConversation, draftConversation } from "../../chat/panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { projectScope } from "../../../app/projectScope";
import { ensureProjectPersona, projectPersonaId } from "../../sandbox/personas/projectPersona";
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
    // A conversation started while a project is open belongs to it: opened there, and, when no persona was named,
    // wearing the project's own (projectPersona.ts), which fences it to the project rather than only starting it
    // there. A named persona is the caller's choice and stands.
    const project = projectScope.value;
    const fitted = actsAs === undefined && project !== undefined ? ensureProjectPersona(project) : undefined;
    conversation.actsAs.value = actsAs ?? (project === undefined ? undefined : projectPersonaId(project));
    conversation.startIn.value = project;
    // The prompt rides the summons, so the turn runs in the window drawing the chat rather than whichever one was
    // clicked (summonTurn).
    if (fitted === undefined && prompt !== undefined) {
        summonTurn(conversation, prompt);
        revealConversation(conversation);
        return conversation.conversationId;
    }
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
    if (fitted === undefined) {
        return conversation.conversationId;
    }
    // The card exists before the first prompt goes, or the daemon would answer an unknown persona with an ordinary
    // chat; a daemon that refuses the card leaves the conversation unpinned rather than pinned to nothing.
    void fitted
        .catch(() => {
            conversation.actsAs.value = undefined;
        })
        .then(() => (prompt === undefined ? undefined : summonTurn(conversation, prompt)));
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

// What a land that moved nothing says, wherever it was pressed. Landed-with-nothing-to-show is the one outcome neither
// the board nor the review can see for itself — both list what the BRANCH holds — so saying nothing left a press that
// did nothing looking exactly like one that worked.
export const NOTHING_LANDED = `Nothing to land: this conversation's branch holds no work your workspace doesn't already have.`;

// A collaborator's stand-in for a land they can't perform (the daemon floors `land` at maintainer): stamps the ask so
// every maintainer's board wears it.
export const requestLandAgent = (id: string, at: AgentReach = undefined): Promise<AgentSummary> =>
    agentJson<AgentSummary>(at, `/agents/${encodeURIComponent(id)}/request-land`, jsonBody(`POST`, {}));

// Makes a member answerable for a conversation (claim, hand over, take over: one route, the daemon decides which the
// caller may). `to` is an address; the daemon checks it against the members it knows.
export const assignAgent = (id: string, to: string, at: AgentReach = undefined): Promise<AgentSummary> =>
    agentJson<AgentSummary>(at, `/agents/${encodeURIComponent(id)}/assign`, jsonBody(`POST`, { to }));

// Puts the caller's mark on a card, or takes it off; the daemon attributes it to the verified identity, so nothing here
// says who. `on` states which, rather than flipping what's stored, so a double press lands where one did.
export const reactToAgent = (id: string, emoji: string, on: boolean, at: AgentReach = undefined): Promise<AgentSummary> =>
    agentJson<AgentSummary>(at, `/agents/${encodeURIComponent(id)}/react`, jsonBody(`POST`, { emoji, on }));

// Hands a land conflict back to the agent to resolve in its own worktree, rather than making the user merge by hand or
// discarding the work. An ordinary turn: it lands in the transcript, a running turn takes it as steering, and Stop
// works on it like any other.

// Whether the turn actually went, and, if not, the one sentence explaining why, so callers can't invent their own
// wording. `settled` marks the sentence as good news — the press found nothing left to do and put the card right —
// which reads as a floating receipt, never as the failure strip an ordinary refusal earns.
export type ResolveAsk = { readonly sent: true } | { readonly sent: false; readonly why: string; readonly settled?: true };

export const askAgentToResolve = async (id: string): Promise<ResolveAsk> => {
    const { agentById, open } = useAgents();
    const agent = agentById(id);
    if (agent !== undefined) {
        open(agent);
    }
    const conversation = useChat().conversations.value.find((candidate) => candidate.conversationId === id);
    // Send only to conversations that still have an open agent card.
    if (conversation === undefined) {
        return { sent: false, why: `That agent has no conversation left to send to.` };
    }
    const { conflicts } = await sandboxJson<AgentChangesResponse>(`/agents/${encodeURIComponent(id)}/diff`);
    // Nothing at all in a report re-derived at read time means the stored refusal has since lost its premise, and the
    // card is sitting in Attention over a clash that no longer exists. That is a repair, not a refusal: see `rejudged`.
    if (conflicts === undefined || conflicts.length === 0) {
        return rejudged(id);
    }
    // Refusing is not a send: the user's own uncommitted edits are the one thing a rebase can't reach, so they're named
    // explicitly rather than sent to the agent as a task.
    const blockers = blockersOf(conflicts);
    if (agentBlockers(blockers).length === 0) {
        const yours = userBlockers(blockers).length;
        return {
            sent: false,
            why:
                yours > 0
                    ? `A rebase can't reach this: ${yours === 1 ? `the blocked file is` : `all ${yours} blocked files are`} held by your own uncommitted edits. Commit or stash them, then land again.`
                    : // A refusal naming no path at all is a repo the land couldn't reach (land.ts). Naming it beats
                      // sending the reader to a report whose entire content is this one sentence.
                      `The land couldn't reach your workspace's copy of ${conflicts.map((conflict) => conflict.repo).join(`, `)}, so there's nothing here for the agent to rebase.`,
        };
    }
    // The app composed this turn, so it runs as the agent, not on whatever the composer in THIS window happens to hold:
    // a tab minted from a history row or a second window carries the last pick made there, and a turn sent on it both
    // spends against a model the user never chose for this agent, relabels the card with it afterwards, and bills an
    // account this conversation was not running on.
    wearAgentRun(conversation, agent);
    // Dispatched, not awaited: `enqueue` doesn't settle until the turn does, and awaiting it here would hold the
    // caller's busy flag across a multi-minute rebase.
    void conversation.enqueue(resolvePrompt(conflicts));
    return { sent: true };
};

// The report has evaporated: every blocker the stored refusal named applies cleanly today. That refusal is what holds
// the card in Attention, and only a land may retire it (agents-registry.recordLanded), so this runs the one land mode
// that judges without writing: `measure` touches no main tree, and re-judges precisely because a refusal is stored.
// Repairing beats reporting — the alternative was a sentence sending the reader to a report with nothing in it.
const rejudged = async (id: string): Promise<ResolveAsk> => {
    try {
        await landAgent(id, `measure`);
        await invalidateAgentAction(id);
        return { sent: false, settled: true, why: `Nothing is blocking this any more: it's ready to land.` };
    } catch {
        // The re-check itself failed (a land holding the repo, a daemon that went away); the card stays as it was.
        return { sent: false, why: `Nothing is blocking this any more, but the re-check didn't go through. Try landing it.` };
    }
};

// What the agent's own turns ran on, as the registry recorded them: the model AND the account that paid for it. Absent
// for an agent that has never run one, which leaves the tab's picks alone — there is nothing better to put there.
const wearAgentRun = (conversation: Conversation, agent: FleetAgent | undefined): void => {
    if (agent === undefined) {
        return;
    }
    if (agent.model !== undefined && agent.model !== ``) {
        conversation.wearModel({
            provider: agent.provider,
            model: agent.model,
            harness: agent.harness,
            ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
            ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
        });
    }
    // After wearModel, never before: pointing at a provider re-scopes the account to that provider's remembered one.
    // Unnamed, the account is the daemon's to pick by headroom, and an account sitting idle BECAUSE it refuses reads
    // there as the emptiest — so the errand hops off the account the work ran on, retiring its session with it.
    if (agent.account !== undefined && agent.account !== ``) {
        conversation.account.value = agent.account;
    }
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
