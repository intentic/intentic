<!-- The model picker footer's first line, the same for every provider and every host: one line of what this footer means now
     on the left, one word of state on the right. Every message the footer has goes here, so none of them stacks as a
     paragraph above or below the account list, and the list itself stays nothing but its rows. -->
<script setup lang="ts">
import { computed, toRef } from "vue";
import { ui } from "@intentic/ui";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { useT } from "@intentic/ui/i18n";
import { formatAge } from "../../../models/providers/usageStatus";
import { usePickerAccounts } from "./pickerAccounts";

const t = useT();

const {
    provider,
    harness,
    model,
    note,
    accounts = true,
} = defineProps<{
    provider: AgentProvider;
    harness: AgentHarness;
    model?: string | undefined;
    // A live turn's sentence (which model it finishes on): said short on the left, whole on hover.
    note?: string | undefined;
    // Whether the account half is this surface's to speak for: off for another box's session, whose accounts pay for nothing here.
    accounts?: boolean;
}>();

const {
    hasContent: listed,
    routedRows,
    unplacedRefusal,
    measuredAt,
    measuring,
    remeasureLabel,
    remeasure,
} = usePickerAccounts(
    toRef(() => provider),
    toRef(() => harness),
    toRef(() => model),
);

// Rows nobody picks between read as a broken list unless something says so; a choosable list needs no caption.
const spread = computed(() => (accounts && routedRows.value.length > 1 ? routedRows.value.length : undefined));
const refusal = computed(() => (accounts ? unplacedRefusal.value : undefined));
// The age doubles as the re-measure control: watching it reset to "now" is the confirmation the press worked. Only over
// meters someone can see: a lone account draws no row, so an age there would date nothing on screen.
const age = computed(() => (accounts && listed.value && measuredAt.value !== undefined ? formatAge(measuredAt.value) : undefined));

const left = computed(() => note !== undefined || spread.value !== undefined);
const right = computed(() => refusal.value !== undefined || age.value !== undefined);
</script>

<template>
    <div v-if="left || right" class="flex min-h-5 items-center justify-between gap-3 text-2xs">
        <span class="flex min-w-0 items-center gap-1.5 text-subtle">
            <!-- A live turn keeps the model it runs on; what is picked here is for the next message. -->
            <template v-if="note !== undefined">
                <Icon name="clock" class="shrink-0" aria-hidden="true" />
                <span class="truncate" role="note" :aria-label="note" v-tooltip.top="note">{{ t(`chat.pickerStatus.nextMessage`) }}</span>
            </template>
            <span v-else-if="spread !== undefined" class="truncate">{{ t(`chat.pickerStatus.spread`, { count: spread }) }}</span>
        </span>

        <!-- The refusal belonging to this selection but no single row: what happened and when, the provider's own words on hover. -->
        <span
            v-if="refusal !== undefined"
            class="flex min-w-0 shrink items-center gap-1 text-warning"
            role="status"
            v-tooltip.top="{ title: refusal.headline, quote: refusal.detail }"
        >
            <Icon name="exclamation-triangle" class="shrink-0" aria-hidden="true" />
            <span class="truncate">{{ refusal.headline }}</span>
        </span>
        <button
            v-else-if="age !== undefined"
            type="button"
            :class="ui.textButton({ tone: `subtle`, size: `xs` })"
            class="shrink-0"
            :disabled="measuring"
            v-tooltip.top="{ title: t(`chat.pickerAccounts.remeasureLimits`), note: t(`chat.pickerAccounts.everyAccount`) }"
            :aria-label="remeasureLabel"
            @click="remeasure"
        >
            <Icon v-if="measuring" name="refresh" class="text-[0.6rem]" spin />
            <span>{{ t(`chat.pickerStatus.measured`, { age }) }}</span>
        </button>
    </div>
</template>
