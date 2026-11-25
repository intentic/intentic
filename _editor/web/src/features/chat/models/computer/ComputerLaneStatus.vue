<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { cancelHarness } from "../../../../models/conversations/accounts/computerSignIn";
import type { ComputerHarness } from "../../../../models/providers/computer/computerHarnesses";
import { useHarnessAttempt } from "./harnessAttempt";

// THE LINE UNDER A CODING AGENT'S LANE THAT CANNOT RUN YET (PickerCatalogStatus.vue), where a sandbox's locked lane says
// connecting would list its models: what it needs, and once its press is pressed (ComputerLaneAction.vue), how that goes
// for as long as it takes (a fetch runs for minutes): continued in the browser on this computer, with the page's address
// where the harness printed one, and how to stop waiting.

const { harness } = defineProps<{ harness: ComputerHarness }>();
const t = useT();

const { attempt, busy, working, pageUrl } = useHarnessAttempt(() => harness);
const named = computed(() => ({ harness: harness.label }));
</script>

<template>
    <!-- A program the account routes do not answer for (computerHarnesses.ts `asked`) has no sign-in a press can run. -->
    <p v-if="!harness.asked" class="px-3 py-1.5 text-2xs text-subtle">{{ t(`chat.computer.harness.terminal`, named) }}</p>
    <div v-else-if="busy" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-2xs text-subtle" role="status">
        <span class="flex min-w-0 flex-1 items-baseline gap-2"><Icon name="spinner" spin class="shrink-0" /><span class="min-w-0">{{ working }}</span></span>
        <a v-if="pageUrl !== undefined" :href="pageUrl" target="_blank" rel="noopener noreferrer" class="text-link hover:underline">
            {{ t(`chat.computer.harness.openPage`) }}
        </a>
        <button type="button" class="text-link hover:underline" @click="cancelHarness(harness.id)">{{ t(`ui.action.cancel`) }}</button>
    </div>
    <p v-else-if="attempt?.phase === `failed`" class="px-3 py-1.5 text-2xs text-danger" role="alert">
        {{ t(`chat.computer.harness.failed`, { harness: harness.label, reason: attempt.error }) }}
    </p>
    <p v-else class="px-3 py-1.5 text-2xs text-subtle">
        {{ harness.standing === `setUp` ? t(`chat.computer.picker.setUpToList`) : t(`chat.computer.picker.signInToList`) }}
    </p>
</template>
