<!-- What this conversation still waits on people for, above its composer, whatever its transcript has scrolled past. -->
<script setup lang="ts">
import { Button, toneRim } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import NeedCard from "./NeedCard.vue";
import { NEED_ICONS } from "../../models/needs/needStatus";
import { useNeeds } from "../../models/needs/useNeeds";
import { useNeedReach } from "./needReach";

const t = useT();

const props = defineProps<{ conversationId: string | undefined }>();

const { openFor } = useNeeds();
const open = openFor(() => props.conversationId);
// Which one is unfolded into its card here; one at a time keeps the composer in reach.
const unfolded = ref<string | undefined>(undefined);
const shown = computed(() => open.value.find((need) => need.id === unfolded.value));
// Waiting on "you" only for a reader who may answer one of them; anyone else is told who it waits on (needReach.ts).
const { mayAnswer, waiter } = useNeedReach();
const headline = computed(() => {
    const count = open.value.length;
    if (open.value.some(mayAnswer)) {
        return t(`needs.strip.waiting`, { count }, count);
    }
    const who = open.value.every((need) => need.subject.kind === `release`) ? `approvers` : waiter.value;
    return t(`needs.strip.waitingOn.${who}`, { count }, count);
});
</script>

<template>
    <!-- The warning's rim on the card's own fill: the strip holds a form, so it stays as legible as the card it opens. -->
    <div v-if="open.length > 0" :class="toneRim(`warning`, `strong`, `flex flex-col gap-2 rounded-xl border bg-card px-3 py-2 text-2xs`)">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Icon name="exclamation-circle" class="shrink-0 text-warning" />
            <span class="shrink-0 font-medium text-content">{{ headline }}</span>
            <!-- Each one a press away from its card, answered here without scrolling to where it was asked. -->
            <Button
                v-for="need in open"
                :key="need.id"
                size="small"
                tier="quiet"
                :tone="unfolded === need.id ? `accent` : undefined"
                class="shrink-0"
                :aria-expanded="unfolded === need.id"
                @click="unfolded = unfolded === need.id ? undefined : need.id"
            >
                <Icon :name="NEED_ICONS[need.subject.kind]" />{{ need.title }}
            </Button>
        </div>
        <NeedCard v-if="shown" :need-id="shown.id" />
    </div>
</template>
