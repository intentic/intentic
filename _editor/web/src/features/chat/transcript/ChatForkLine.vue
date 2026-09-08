<script setup lang="ts">
import { computed } from "vue";
import { useAgents } from "../../agents/fleet/useAgents";
import { useChat } from "../run/useChat";
import { usePaneView } from "../panel/useChat-view";
import { openAgentConversation } from "../panel/useChat-reveal";

// Banner at the top of a forked transcript linking back to the chat it inherited turns from, so the two stay
// comparable. Read from the fleet registry rather than the tab, since the registry has carried the fork's source since
// the first turn, unlike a reopened tab.

const { conversation } = usePaneView();
const { agentById } = useAgents();
const { conversations, setActive } = useChat();

const forkedFrom = computed(() => agentById(conversation.value.conversationId)?.forkedFrom);
const source = computed(() => (forkedFrom.value === undefined ? undefined : agentById(forkedFrom.value.conversationId)));

// Source may be open, closed, or discarded entirely; only the first two are a real destination to link to.
const reachable = computed(() => source.value !== undefined);
const label = computed(() => source.value?.title ?? `the chat this was forked from`);

// Which files the fork started on: the only record of whether inherited turns match today's workspace.
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
