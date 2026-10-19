<script setup lang="ts">
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import { agentDisplayTitle } from "../../../models/agent-status/agentStatus-meta";
import { useAgents } from "../../../models/fleet/useAgents";
import { FRESH_ICONS } from "../../../models/fleet/freshKinds";
import { usePaneView } from "../../../models/conversations/panel/useChat-view";
import { openAgentConversation } from "../../../models/conversations/panel/useChat-reveal";

// Banner at the top of a fresh session's transcript (freshSession.ts): what it was opened for and on whose work, linking
// back there, and that it started without that conversation, which is why its findings read the work on its own terms.
// Read from the fleet registry, like the fork's line (ChatForkLine), since the registry keeps the link after reopening.

const t = useT();

const { conversation } = usePaneView();
const { agentById } = useAgents();

// Not before its first message is taken: until then the strip over the composer says it (ChatFreshDraft).
const fresh = computed(() => (conversation.value.pendingFreshOf.value === undefined ? agentById(conversation.value.conversationId)?.fresh : undefined));
const origin = computed(() => (fresh.value === undefined ? undefined : agentById(fresh.value.of)));

const openOrigin = (): void => {
    if (origin.value !== undefined) {
        openAgentConversation(origin.value);
    }
};
</script>

<template>
    <div v-if="fresh" class="flex items-center justify-center gap-1.5 px-3 pb-1 text-2xs text-subtle" data-fresh-line>
        <Icon :name="FRESH_ICONS[fresh.kind]" class="text-2xs" />
        <span>
            <i18n-t keypath="agents.freshSession.lineOf" scope="global">
                <template #kind>{{ t(`agents.freshSession.lineKind.${fresh.kind}`) }}</template>
                <template #title>
                    <button
                        v-if="origin"
                        type="button"
                        class="touch-target cursor-pointer underline decoration-dotted underline-offset-2 hover:text-content"
                        @click="openOrigin"
                    >
                        {{ agentDisplayTitle(origin) }}
                    </button>
                    <span v-else class="italic">{{ t(`agents.freshSession.originGone`) }}</span>
                </template>
            </i18n-t>
            <span> · {{ t(`agents.freshSession.lineNote`) }}</span>
        </span>
    </div>
</template>
