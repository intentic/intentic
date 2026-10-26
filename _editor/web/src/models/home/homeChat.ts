import type { HomeConversation } from "@intentic/sandbox-contract/schemas/agents-list";
import { shallowRef } from "vue";
import { agentTabOf } from "../conversations/panel/useChat-reveal";
import { hydrateOnce } from "../conversations/run/useChat-sessions";
import { Conversation } from "../conversations/session/conversation";
import { restoreTab } from "../conversations/tabs/useChat-tabs";
import { useChat } from "../conversations/run/useChat";

// THE MASTER VIEW'S ONE CHAT: the person's home conversation in the active sandbox, pinned to the panel the view lends
// its page (features/home/HomeChatSlot.vue). Built for that panel rather than seated among the shell's chat tabs, so
// neither the tabs a sandbox switch restores, nor a chat popped out into its own window, decides what it shows, and
// opening the master view moves nothing in the shell's own chat. A tab of it already open is the same conversation, and
// is reused rather than twinned.

// allow(module-state): the conversation the master view's panel draws, one per window
export const homeConversation = shallowRef<Conversation | undefined>();

// The sandbox whose home conversation the master view has on screen, ready for a message: what a sandbox made on Home
// waits on for its first start, where no workspace is drawn for its gate to pass (AddSandboxOpening.vue).
// allow(module-state): one master view per window
export const homeShownFor = shallowRef<string | undefined>();

// Each sandbox's home kept for this page load, so coming back to a sandbox finds its home as it was left.
const held = new Map<string, Conversation>();

/** The live conversation for a sandbox's home, opened (an existing one replayed from its card) on first ask. */
export const homeConversationFor = (sandboxId: string, home: HomeConversation, title: string): Conversation => {
    const open = useChat().conversations.value.find((conversation) => conversation.conversationId === home.conversationId);
    if (open !== undefined) {
        return open;
    }
    const key = `${sandboxId}:${home.conversationId}`;
    const kept = held.get(key);
    if (kept !== undefined) {
        return kept;
    }
    const conversation = home.agent === undefined ? new Conversation(home.conversationId) : restoreTab({ ...agentTabOf(home.agent), isolated: true });
    if (home.agent !== undefined) {
        hydrateOnce(conversation);
    }
    // Its first turn opens it in a copy of its own (the daemon refuses a home on the shared tree), named as the home.
    conversation.isolated.value = true;
    conversation.title.value ??= title;
    held.set(key, conversation);
    return conversation;
};
