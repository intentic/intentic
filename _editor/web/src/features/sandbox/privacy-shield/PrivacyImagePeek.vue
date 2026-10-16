<script setup lang="ts">
import { Icon, SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, toRef } from "vue";
import { usePrivacyImage } from "../../../models/sandbox/usePrivacyShield";

// One image the shield painted over, as it was and as the provider got it, for the owner checking what was covered:
// one picture at a time in the same frame, so flipping between the two shows exactly what changed.

const t = useT();

const { id } = defineProps<{ id: string }>();

const { pair, isLoading, failed } = usePrivacyImage(toRef(() => id));

type Side = `before` | `after`;
// What left first: the row above is about what the provider read, and the picture before is the one to ask for.
const side = ref<Side>(`after`);
const SIDES = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.imageBefore`), value: `before` as const },
    { label: t(`sandbox.agentPrivacyShield.imageAfter`), value: `after` as const },
]);

const source = computed(() => {
    const image = pair.value?.[side.value];
    return image === undefined ? undefined : `data:${image.mediaType};base64,${image.data}`;
});
</script>

<template>
    <div class="flex flex-col gap-2 rounded-md border border-line bg-content/5 p-2">
        <div class="flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl v-model="side" :options="SIDES" size="xs" :aria-label="t(`sandbox.agentPrivacyShield.imagePeekLabel`)" />
            <span class="text-2xs text-subtle">{{
                side === `before` ? t(`sandbox.agentPrivacyShield.imageBeforeNote`) : t(`sandbox.agentPrivacyShield.imageAfterNote`)
            }}</span>
        </div>
        <p v-if="failed" class="flex items-center gap-1.5 text-2xs text-subtle">
            <Icon name="image" />{{ t(`sandbox.agentPrivacyShield.imageGone`) }}
        </p>
        <div v-else-if="isLoading || source === undefined" class="h-32 animate-pulse rounded bg-content/5" />
        <img
            v-else
            :src="source"
            :alt="side === `before` ? t(`sandbox.agentPrivacyShield.imageBefore`) : t(`sandbox.agentPrivacyShield.imageAfter`)"
            class="max-h-96 max-w-full self-start rounded border border-line object-contain"
        />
    </div>
</template>
