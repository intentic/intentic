<script setup lang="ts">
import { computed } from "vue";
import { useAgents } from "../composables/agents/useAgents";
import { openAgentConversation, useChat, usePaneView } from "../composables/chat/useChat";

/* WHERE THIS CHAT CAME FROM, at the top of the transcript it inherited.
 *
 * A fork opens holding somebody else's turns. Without a line saying so, those turns read as this conversation's
 * own beginning — and the two chats, which exist to be COMPARED, look unrelated. So the relationship is stated
 * exactly where the inherited history starts, and it is a link: the reason to have forked is to go back and
 * forth between the two answers.
 *
 * Read from the fleet rather than from the tab, because the tab is the half that does not last. Closing this
 * chat and reopening it from history builds a new tab that knows nothing, while the registry entry has carried
 * the fork's source since its first turn — and it is the same read from either end (see the source's own mark
 * in ChatForkCut). */

const { conversation } = usePaneView();
const { agentById } = useAgents();
const { conversations, setActive } = useChat();

const forkedFrom = computed(() => agentById(conversation.value.conversationId)?.forkedFrom);
const source = computed(() => (forkedFrom.value === undefined ? undefined : agentById(forkedFrom.value.conversationId)));

// The source may be open in this window, closed, or gone entirely (discarded). The first two are a destination;
// the third is not, and a link that opened nothing would be worse than plain text.
const reachable = computed(() => source.value !== undefined);
const label = computed(() => source.value?.title ?? `the chat this was forked from`);

/* AND WHICH FILES IT STARTED ON. Said out loud, permanently, because it is the half of a fork that has no other
 * evidence: the inherited turns are on screen, but whether the workspace under them is the one those turns
 * describe or the one that exists today is invisible — and getting it wrong is how an agent ends up reasoning
 * about edits that are not there. */
const files = computed(() =>
    forkedFrom.value?.files === `then` ? `on the files as they were at that point` : `on the files as they stood when it was forked`,
);

const openSource = (): void => {
    const id = forkedFrom.value?.conversationId;
    const agent = source.value;
    if (id === undefined || agent === undefined) {
        return;
    }
    if (conversations.value.some((open) => open.conversationId === id)) {
        setActive(id);
        return;
    }
    openAgentConversation(agent);
};
</script>

<template>
    <div v-if="forkedFrom" class="flex items-center justify-center gap-1.5 px-3 pb-1 text-2xs text-subtle">
        <Icon name="fork" class="text-2xs" />
        <span>
            Forked from
            <button
                v-if="reachable"
                type="button"
                class="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-content"
                @click="openSource"
            >
                {{ label }}
            </button>
            <span v-else class="italic">a chat that is no longer here</span>
            <span> · {{ files }}</span>
        </span>
    </div>
</template>
