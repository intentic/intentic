import type { AgentCommand } from "@intentic/sandbox-contract/events/requests";
import { t } from "@intentic/ui/i18n";
import { ensureProviderCommands } from "../conversations/accounts/useChat-catalog";
import { composingConversation } from "../conversations/panel/useChat-reveal";
import { summonChat } from "../conversations/run/summon";
import type { Conversation } from "../conversations/session/conversation";
import { providerCommands } from "../providers/providerCatalog";
import { reviewCommandOf } from "../providers/reviewCommands";
import { openConversation, revealConversation } from "./agentActions";

// "Review these changes", from wherever changes are looked at: the conversation's own review, or the reader's uncommitted
// work. The ask goes into a composer rather than straight out, since a turn may be running and the reader may want a
// level or a target first. Each harness's own reviewer is asked by the name its `/` list publishes (reviewCommands.ts),
// and its findings come back as the chat's review card; a harness with no reviewer is asked in words.

// The command ready for its arguments (a level, a branch), or the ask in words where the harness has no reviewer.
const reviewDraft = (commands: readonly AgentCommand[]): string => {
    const command = reviewCommandOf(commands);
    return command === undefined ? t(`agents.reviewAsk.inWords`) : `/${command} `;
};

// The list the composer's `/` popover reads (useChat-view's availableCommands): the conversation's own, else its
// provider's, fetched first where nothing is known yet.
const commandsOf = async (conversation: Conversation): Promise<readonly AgentCommand[]> => {
    if (conversation.availableCommands.value.length > 0) {
        return conversation.availableCommands.value;
    }
    const provider = conversation.selection.provider.value;
    // allow(silent-catch): a list nobody could fetch leaves the ask in words, which every harness answers
    await ensureProviderCommands(provider).catch(() => undefined);
    return providerCommands.value[provider] ?? [];
};

const show = (conversation: Conversation): void => {
    summonChat({ kind: `reveal`, verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: true });
    revealConversation(conversation);
};

// The agent reviews its own branch, in its own conversation: it holds the context the findings are about.
export const draftReviewAsk = async (id: string): Promise<void> => {
    const conversation = openConversation(id);
    if (conversation === undefined) {
        return;
    }
    conversation.draft.value = reviewDraft(await commandsOf(conversation));
    show(conversation);
};

// The reader's own uncommitted work lives in the shared tree, which no new worktree holds: the review runs there, as an
// analysis chat rather than the main tree's default plan mode, which would drive toward a plan instead of findings.
export const draftWorkspaceReview = async (): Promise<void> => {
    const conversation = composingConversation();
    conversation.isolated.value = false;
    conversation.selection.apply({ kind: `set`, picks: { modePick: `default` } });
    conversation.draft.value = reviewDraft(await commandsOf(conversation));
    show(conversation);
};
