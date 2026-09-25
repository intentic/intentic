<script setup lang="ts">
import type { MainlineRouting } from "@intentic/sandbox-contract";
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { type MainlineRed, routingMeta } from "./mainlineView";
import { openLandConversation, useLandTitle } from "./openLanded";

// Who has the red, said at rest beside the main line's segment: the one thing about a red a reader can act on without
// opening anything is the conversation fixing it, so that is one press away. Nothing while main is not red.

const t = useT();

const props = defineProps<{
    red: MainlineRed | undefined;
}>();

// A conversation was opened from here, so a host that is a sheet can get out of the way.
const emit = defineEmits<{ opened: [conversationId: string] }>();

const landTitle = useLandTitle();
const routing = computed(() => (props.red === undefined ? undefined : routingMeta(props.red.routing?.kind)));

// Handed the whole routing rather than its id, so a press never has to trust a narrowing made outside it.
const openRouted = (decided: MainlineRouting | undefined): void => {
    if (decided?.conversationId === undefined) {
        return;
    }
    openLandConversation(decided.conversationId);
    emit(`opened`, decided.conversationId);
};
</script>

<template>
    <span v-if="red !== undefined && routing !== undefined" data-routing class="flex min-w-0 items-center gap-1.5 px-1 text-muted">
        <Icon :name="routing.icon" class="shrink-0 text-2xs" />
        <span class="min-w-0 truncate" v-tooltip.top="red.routing?.detail">{{ routing.words }}</span>
        <button
            v-if="red.routing?.conversationId !== undefined"
            type="button"
            :class="ui.linkButton(`shrink-0 gap-1 text-2xs`)"
            :aria-label="t(`agents.mainline.openConversation`, { title: landTitle(red.routing.conversationId) })"
            @click="openRouted(red?.routing)"
        >
            {{ t(`agents.mainline.open`) }}<Icon name="arrow-right" class="text-2xs" />
        </button>
    </span>
</template>
