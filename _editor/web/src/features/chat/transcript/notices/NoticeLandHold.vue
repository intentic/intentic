<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { effectiveAutoLand } from "../../../agents/fleet/agentStatus";
import { useAgents } from "../../../agents/fleet/useAgents";
import { landsByDefault } from "../../../sandbox/environment/rules";
import { useSandboxSettings } from "../../../sandbox/overview/useSandboxSettings";
import { usePaneView } from "../../panel/useChat-view";
import type { ChatMessage } from "../transcript";

/* A landed turn's one-press opt-out from future auto-land, offered while this agent still lands by itself. */

defineProps<{ message: ChatMessage }>();

const t = useT();
const { conversation } = usePaneView();
const { agentById, setAutoLand } = useAgents();
const { settings } = useSandboxSettings();
const offered = computed(() => effectiveAutoLand(agentById(conversation.value.conversationId), landsByDefault(settings.value?.rules ?? [])));

// Best-effort like markSeen: a failed write leaves the offer standing to press again.
const hold = async (): Promise<void> => {
    await setAutoLand(conversation.value.conversationId, false).catch(() => undefined);
};
</script>

<template>
    <template v-if="offered">
        <button type="button" class="shrink-0 font-medium text-link hover:underline" @click="hold">
            {{ t(`chat.chatMessageView.keepFutureWorkOn`) }}
        </button>
        <span class="shrink-0">{{ t(`chat.chatMessageView.waitsReadyToLand`) }}</span>
    </template>
</template>
