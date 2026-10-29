import type { RepoBranch } from "@intentic/sandbox-contract/schemas/shared";
import { agentScope, branchScope, SHARED_SCOPE, type ViewScope } from "../../../app/workspaceScope";
import { draftConversation } from "../../conversations/panel/useChat-reveal";
import { summonChat } from "../../conversations/run/summon";
import type { Conversation } from "../../conversations/session/conversation";
import { revealConversation } from "../agentActions";
import type { FleetAgent } from "../useAgents-fleet";

// A NEW AGENT ON A BRANCH: a chat whose private copy of one repository is cut from that branch's tip rather than the main
// line, and whose finished work is committed onto that branch (schemas/conversation-links.ts FROM_BRANCH_DESCRIPTION).
// The shared workspace never leaves its main line for it. The link rides the opening turn only (turnPost.ts), so it is
// a draft's to set and to drop: once the board has the conversation, where it started is the card's to say.

/** Whether a start can still be chosen for this chat: nothing sent yet, a private copy, and here rather than elsewhere. */
export const startChoosable = (conversation: Conversation): boolean =>
    !conversation.registered.value &&
    conversation.transcript.messages.value.length === 0 &&
    conversation.isolated.value &&
    conversation.runner.value === undefined &&
    conversation.box.value === undefined;

/** Starts this draft from `from`: a branch start is a start of its own, so a fork or a fresh session it held goes. */
export const startOnBranch = (conversation: Conversation, from: RepoBranch): void => {
    conversation.isolated.value = true;
    conversation.pendingForkOf.value = undefined;
    conversation.pendingFreshOf.value = undefined;
    conversation.pendingFromBranch.value = { repo: from.repo, branch: from.branch };
};

/** Starts this draft from another agent's copy, as its reader's own ask (freshSession.ts): its work lands back there. */
export const startOnCopy = (conversation: Conversation, origin: Pick<FleetAgent, "id" | "actsAs" | "startIn">): void => {
    conversation.isolated.value = true;
    conversation.pendingForkOf.value = undefined;
    conversation.pendingFromBranch.value = undefined;
    conversation.pendingFreshOf.value = { conversationId: origin.id, kind: `ask` };
    conversation.selection.apply({ kind: `set`, picks: { actsAs: origin.actsAs, startIn: origin.startIn } });
};

/** Back to the main line. */
export const unlinkBranch = (conversation: Conversation): void => {
    conversation.pendingFromBranch.value = undefined;
};

/** Back to the main line from either start: a branch, or another agent's copy taken as the reader's own ask. */
export const startOnMainLine = (conversation: Conversation): void => {
    conversation.pendingFromBranch.value = undefined;
    if (conversation.pendingFreshOf.value?.kind === `ask`) {
        conversation.pendingFreshOf.value = undefined;
    }
};

/** Where this draft starts, as the picker names a copy. */
export const startScopeOf = (conversation: Conversation): ViewScope => {
    const branch = conversation.pendingFromBranch.value;
    if (branch !== undefined) {
        return branchScope(branch);
    }
    const fresh = conversation.pendingFreshOf.value;
    return fresh?.kind === `ask` ? agentScope(fresh.conversationId) : SHARED_SCOPE;
};

/** Whether the control is offered for this conversation, and whether it is set off the main line. */
export interface StartFromFacts {
    readonly startOffered: boolean;
    readonly startSet: boolean;
}

export const startFromFacts = (conversation: Conversation): StartFromFacts => {
    const fresh = conversation.pendingFreshOf.value;
    return {
        startOffered: startChoosable(conversation) && conversation.pendingForkOf.value === undefined && (fresh === undefined || fresh.kind === `ask`),
        startSet: conversation.pendingFromBranch.value !== undefined || fresh?.kind === `ask`,
    };
};

/** Opens a new chat started from `from`, its composer focused: the reader writes the ask and presses Send. */
export const draftFromBranch = (from: RepoBranch): void => {
    const conversation = draftConversation();
    startOnBranch(conversation, from);
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
};
