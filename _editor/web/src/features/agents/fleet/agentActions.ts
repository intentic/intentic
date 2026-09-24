import type { AgentChangesResponse } from "@intentic/api-contract";
import type { AgentSpan, AgentSummary, LandMode, LandResult } from "@intentic/sandbox-contract";
import { useDevice } from "@intentic/ui";
import type { Conversation } from "../../chat/session/conversation";
import { errands } from "../../chat/run/errands";
import { summonChat, summonTurn } from "../../chat/run/summon";
import { useChat } from "../../chat/run/useChat";
import { transcriptShown } from "../../chat/run/useChat-sessions";
import { composingConversation, draftConversation } from "../../chat/panel/useChat-reveal";
import { queryClient } from "../../../lib/queryPersistence";
import { projectScope } from "../../../app/projectScope";
import { ensureProjectPersona, projectPersonaId } from "../../sandbox/personas/projectPersona";
import { router } from "../../../router";
import { otherBoxes, refreshAcross } from "../../sandbox/live/fleetAcross";
import { refreshChangesAcross } from "../../workspace/changes/changesAcross";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { agentBlockers, blockersOf, resolvePrompt, userBlockers } from "../review/conflictResolution";
import type { FleetAgent } from "./useAgents-fleet";
import { claim, underClaim } from "./useAgents-provisional";
import { useAgents } from "./useAgents";
import { agentReviewKeys } from "./useAgents-registry";
import { rpcPrefix, workingReviewKeys } from "../../../lib/queryKeys";
import { t } from "@intentic/ui/i18n";

// The fleet's mutations, addressed by agent id: the shared source for the review panel's bindings and the board's
// drag-to-act drops. Land and discard are refused daemon-side while the agent's turn is running, since the worktree is
// that turn's live working state.

// Threaded through every mutation as a trailing optional argument: undefined means the active sandbox, a value means
// the wider board acting on another box's card. Every mutation crosses except `askAgentToResolve`, which sends a
// message through the chat singleton and so never will.
export type AgentReach = string | undefined;

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
    conversation.selection.apply({
        kind: `set`,
        picks: { actsAs: actsAs ?? (project === undefined ? undefined : projectPersonaId(project)), startIn: project },
    });
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
        .catch((error: unknown) => {
            // The turn still goes, unfenced: the one trace of why is this line.
            console.warn(`startAgent: project persona for ${project} was refused; the conversation runs unfenced`, error);
            conversation.selection.apply({ kind: `set`, picks: { actsAs: undefined } });
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
// the card's `landing` status, drawn from the press on, carries the wait. `measure` moves no card: it only re-judges.
export const landAgent = (
    id: string,
    mode: LandMode = `check`,
    span: AgentSpan = `outstanding`,
    force = false,
    at: AgentReach = undefined,
): Promise<LandResult> => {
    const request = (): Promise<LandResult> => sandboxRpc.agents.land({ id, mode, span, force }, { context: { at, deadline: false } });
    return mode === `measure` ? request() : underClaim(id, at, `land`, request, (result) => result.landed);
};

// What a land that moved nothing says, wherever it was pressed. Landed-with-nothing-to-show is the one outcome neither
// the board nor the review can see for itself — both list what the BRANCH holds — so saying nothing left a press that
// did nothing looking exactly like one that worked.
export const nothingLanded = (): string => t(`agents.agentActions.nothingLanded`);

// A collaborator's stand-in for a land they can't perform (the daemon floors `land` at maintainer): stamps the ask so
// every maintainer's board wears it.
export const requestLandAgent = (id: string, at: AgentReach = undefined): Promise<AgentSummary> =>
    sandboxRpc.agents.requestLand({ id }, { context: { at } });

// Makes a member answerable for a conversation (claim, hand over, take over: one route, the daemon decides which the
// caller may). `to` is an address; the daemon checks it against the members it knows.
export const assignAgent = (id: string, to: string, at: AgentReach = undefined): Promise<AgentSummary> =>
    sandboxRpc.agents.assign({ id, to }, { context: { at } });

// Puts the caller's mark on a card, or takes it off; the daemon attributes it to the verified identity, so nothing here
// says who. `on` states which, rather than flipping what's stored, so a double press lands where one did.
export const reactToAgent = (id: string, emoji: string, on: boolean, at: AgentReach = undefined): Promise<AgentSummary> =>
    sandboxRpc.agents.react({ id, emoji, on }, { context: { at } });

// Hands a land conflict back to the agent to resolve in its own worktree, rather than making the user merge by hand or
// discarding the work. An ordinary turn: it lands in the transcript, a running turn takes it as steering, and Stop
// works on it like any other.

// How the press ended, with the one sentence each outcome owes, so callers can't invent their own wording.
export type ResolveAsk =
    // The daemon took the turn.
    | { readonly kind: `sent` }
    // Nothing was left to resolve and the press put the card right: good news, told as a floating receipt.
    | { readonly kind: `settled`; readonly why: string }
    // No turn could help, told on the caller's failure strip.
    | { readonly kind: `refused`; readonly why: string }
    // Opened but never taken (a Stop, a refusal at the door, a later press); whatever ended it has said so already.
    | { readonly kind: `dropped` };

// The card moves and the chat opens the turn on the press, and the report its words need is read meanwhile, not first.
// Resolves once the daemon took the turn or it went nowhere, never at its end, which would hold a busy flag for minutes.
export const askAgentToResolve = async (id: string): Promise<ResolveAsk> => {
    const { agentById, open } = useAgents();
    const agent = agentById(id);
    if (agent !== undefined) {
        open(agent);
    }
    const conversation = openConversation(id);
    // Send only to conversations that still have an open agent card.
    if (conversation === undefined) {
        return { kind: `refused`, why: `That agent has no conversation left to send to.` };
    }
    const press = claim(id, undefined, `turn`);
    const read = new AbortController();
    // The verdict alone, not the whole review: the review's per-file line counts cost tens of seconds on a large
    // branch, and the turn waited on them before anything reached the daemon or any other window watching this chat.
    const report = sandboxRpc.agents.conflicts({ id }, { signal: read.signal });
    // Awaited only inside `compose`, which a superseded press never reaches; its rejection is still thrown there.
    report.catch(() => undefined);
    // Settled by `compose` itself whenever it answers without a prompt; a turn that never went says nothing.
    let unsent: ResolveAsk = { kind: `dropped` };
    let taken = false;
    try {
        await transcriptShown(conversation);
        // A press made on this card while its chat was painting (a Stop, a discard) is the one that counts.
        if (!press.stands()) {
            read.abort();
            return unsent;
        }
        // The app composed this turn, so it runs as the agent, not on whatever the composer in THIS window happens to
        // hold: a tab minted from a history row or a second window carries the last pick made there, and a turn sent on
        // it both spends against a model the user never chose for this agent, relabels the card with it afterwards, and
        // bills an account this conversation was not running on.
        wearAgentRun(conversation, agent);
        taken = await conversation.turn.startErrand(errands().landConflict.opening, async (signal) => {
            signal.addEventListener(`abort`, () => read.abort());
            const { conflicts } = await report;
            const answer = await answerFor(id, conflicts);
            if (typeof answer === `string`) {
                return answer;
            }
            unsent = answer;
            return undefined;
        });
    } finally {
        press.settle(taken);
    }
    return taken ? { kind: `sent` } : unsent;
};

// What a freshly read report asks of the press: the prompt to send, or the reason there is none.
const answerFor = async (id: string, conflicts: AgentChangesResponse[`conflicts`]): Promise<string | ResolveAsk> => {
    // Nothing at all in a report re-derived at read time means the stored refusal has since lost its premise, and the
    // card is sitting in Attention over a clash that no longer exists. That is a repair, not a refusal: see `rejudged`.
    if (conflicts === undefined || conflicts.length === 0) {
        return rejudged(id);
    }
    // Refusing is not a send: the user's own uncommitted edits are the one thing a rebase can't reach, so they're named
    // explicitly rather than sent to the agent as a task.
    const blockers = blockersOf(conflicts);
    if (agentBlockers(blockers).length > 0) {
        return resolvePrompt(conflicts);
    }
    const yours = userBlockers(blockers).length;
    return {
        kind: `refused`,
        why:
            yours > 0
                ? `A rebase can't reach this: ${yours === 1 ? `the blocked file is` : `all ${yours} blocked files are`} held by your own uncommitted edits. Commit or stash them, then land again.`
                : // A refusal naming no path at all is a repo the land couldn't reach (land.ts). Naming it beats sending
                  // the reader to a report whose entire content is this one sentence.
                  `The land couldn't reach your workspace's copy of ${conflicts.map((conflict) => conflict.repo).join(`, `)}, so there's nothing here for the agent to rebase.`,
    };
};

// The report has evaporated: every blocker the stored refusal named applies cleanly today. That refusal is what holds
// the card in Attention, and only a land may retire it (agents-registry.recordLanded), so this runs the one land mode
// that judges without writing: `measure` touches no main tree, and re-judges precisely because a refusal is stored.
// Repairing beats reporting — the alternative was a sentence sending the reader to a report with nothing in it.
const rejudged = async (id: string): Promise<ResolveAsk> => {
    try {
        await landAgent(id, `measure`);
        await invalidateAgentAction(id);
        return { kind: `settled`, why: `Nothing is blocking this any more: it's ready to land.` };
    } catch {
        // The re-check itself failed (a land holding the repo, a daemon that went away); the card stays as it was.
        return { kind: `refused`, why: `Nothing is blocking this any more, but the re-check didn't go through. Try landing it.` };
    }
};

// What the agent's own turns ran on, as the registry recorded them: the model AND the account that paid for it. Absent
// for an agent that has never run one, which leaves the tab's picks alone — there is nothing better to put there.
const wearAgentRun = (conversation: Conversation, agent: FleetAgent | undefined): void => {
    if (agent === undefined) {
        return;
    }
    if (agent.model !== undefined && agent.model !== ``) {
        conversation.selection.apply({
            kind: `wearModel`,
            pin: {
                provider: agent.provider,
                model: agent.model,
                harness: agent.harness,
                ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
                ...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
            },
        });
    }
    // After wearModel, never before: pointing at a provider re-scopes the account to that provider's remembered one.
    // Unnamed, the account is the daemon's to pick by headroom, and an account sitting idle BECAUSE it refuses reads
    // there as the emptiest — so the errand hops off the account the work ran on, retiring its session with it.
    if (agent.account !== undefined && agent.account !== ``) {
        conversation.selection.apply({ kind: `set`, picks: { account: agent.account } });
    }
};

// Discard: drop the worktrees, the agent/<id> branches, and the registry entry. Irreversible; the card leaves on the
// press and comes back only if the daemon refuses.
export const discardAgent = (id: string, at: AgentReach = undefined): Promise<void> =>
    underClaim(id, at, `discard`, async () => {
        await sandboxRpc.agents.discard({ id }, { context: { at } });
    });

// Scratch is what a land leaves in the conversation's copy (AgentChanges.scratch). Including stages it there, so the
// next land carries it; deleting removes it from the copy. Both name paths exactly as the review listed them.
export const includeAgentScratch = async (id: string, repo: string, paths: readonly string[], at: AgentReach = undefined): Promise<void> => {
    await sandboxRpc.agents.includeScratch({ id, repo, paths: [...paths] }, { context: { at } });
};

export const deleteAgentScratch = async (id: string, repo: string, paths: readonly string[], at: AgentReach = undefined): Promise<void> => {
    await sandboxRpc.agents.deleteScratch({ id, repo, paths: [...paths] }, { context: { at } });
};

// The run a card shows under way, from whichever roster it came from; undefined for a turn with none to name.
const shownRun = (id: string, at: AgentReach): string | undefined =>
    (at === undefined ? useAgents().agentById(id) : otherBoxes.value.find((box) => box.sandbox.id === at)?.agents.find((agent) => agent.id === id))
        ?.run;

// True cancel for an in-flight turn, the card reading `stopping` from the press: an open streaming tab runs its own
// stop(), else the daemon is told; another box's card never takes the tab branch, since an id repeats across boxes. The
// press names the run its card shows, so it cannot cancel a turn that started after it; `live` is for a caller setting
// the conversation aside whichever turn it is on.
export const stopAgent = (id: string, at: AgentReach = undefined, options: { readonly live?: true } = {}): Promise<void> =>
    underClaim(id, at, `stop`, async () => {
        const { conversations } = useChat();
        const conversation = at === undefined ? conversations.value.find((candidate) => candidate.conversationId === id) : undefined;
        if (conversation !== undefined && conversation.turn.streaming.value && options.live === undefined) {
            conversation.turn.stop();
            return;
        }
        const run = options.live === undefined ? shownRun(id, at) : undefined;
        await sandboxRpc.agent.stop(run === undefined ? { conversationId: id, live: true } : { conversationId: id, run }, { context: { at } });
    });

// After a land or discard, invalidate the agent's review plus the workspace-wide changes and snapshot history so every
// surface converges. The two workspace reads go by prefix, every box's, since a land in another box changes that box's
// own `/work`.
export const invalidateAgentAction = async (id: string, at: AgentReach = undefined): Promise<void> => {
    if (at !== undefined) {
        refreshAcross();
        // ...and the changes ledger too: landing into another box's /work is exactly what moves its uncommitted count.
        refreshChangesAcross();
    }
    await Promise.all(
        [...agentReviewKeys(id, at), ...workingReviewKeys, rpcPrefix(`history.list`)].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
};
