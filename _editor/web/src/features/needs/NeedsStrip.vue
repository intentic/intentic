<!-- What this conversation still waits on people for, above its composer, whatever its transcript has scrolled past. -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import NeedCard from "./NeedCard.vue";
import { NEED_ICONS } from "./needStatus";
import { useNeeds } from "./useNeeds";

const t = useT();

const props = defineProps<{ conversationId: string | undefined }>();

const { openFor } = useNeeds();
const open = openFor(() => props.conversationId);
// Which one is unfolded into its card here; one at a time keeps the composer in reach.
const unfolded = ref<string | undefined>(undefined);
const shown = computed(() => open.value.find((need) => need.id === unfolded.value));
</script>

<template>
    <div v-if="open.length > 0" class="flex flex-col gap-2 rounded-xl border border-warning/40 bg-card px-3 py-2 text-2xs">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Icon name="exclamation-circle" class="shrink-0 text-warning" />
            <span class="shrink-0 font-medium text-content">{{ t(`needs.strip.waiting`, { count: open.length }, open.length) }}</span>
            <!-- Each one a press away from its card, answered here without scrolling to where it was asked. -->
            <Button
                v-for="need in open"
                :key="need.id"
                size="small"
                :text="true"
                :severity="unfolded === need.id ? undefined : `secondary`"
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
