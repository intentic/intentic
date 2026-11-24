<!-- Where an ask was made, while the dock above the composer carries its card: one line, and the press that opens it there. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAskDock } from "./askDock";
import { askLabel } from "./askWords";

const t = useT();

const props = defineProps<{ askKey: string }>();

const dock = useAskDock();
const ask = computed(() => dock?.find(props.askKey));
const label = computed(() => (ask.value === undefined ? `` : askLabel(ask.value, t)));
</script>

<template>
    <!-- The card's own measures and header (chat.css), so the stub reads as the card folded to its head. -->
    <div v-if="ask" class="chat-card w-full" data-ask-stub>
        <div class="chat-card-header items-center text-xs">
            <Icon :name="ask.icon" class="text-sm text-accent" />
            <span class="min-w-0 truncate text-muted" v-tooltip.top.overflow="label">{{ label }}</span>
            <Button size="small" tier="quiet" @click="dock?.answer(askKey)">
                <Icon name="arrow-down" />{{ dock?.canDrive.value ? t(`ui.action.answer`) : t(`chat.askDock.show`) }}
            </Button>
        </div>
    </div>
</template>
