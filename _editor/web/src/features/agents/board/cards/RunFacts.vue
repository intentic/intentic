<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ProviderLogo from "../../../chat/accounts/ProviderLogo.vue";
import { effortRungFill } from "../../../chat/models/run-settings/effortScale";
import type { RunLook } from "./childLook";

// WHAT A CHILD RUNS ON, IN WORDS: the model by its catalog name and the tier it ran at, drawn on the composer's own
// ladder (EffortMeter) so a child's tier reads the way the reader set their own, with the tier's word beside it. On a
// tray row it is a quiet run of text under the title; on the subagent bar, where the composer would say the same thing,
// each fact is a chip of its own. Nothing here is a hover away: the whole point is that it is on screen.

const props = defineProps<{
    run: RunLook;
    // The bar's chips, rather than the row's run of text.
    chips?: boolean;
}>();

const t = useT();

const rungs = computed(() =>
    Array.from({ length: props.run.effort?.rungs ?? 0 }, (_, index) =>
        index <= (props.run.effort?.rung ?? -1) ? effortRungFill(index, props.run.effort?.rungs ?? 0) : undefined,
    ),
);
const pill = computed(() => (props.chips === true ? `ui-status-pill bg-content/5 text-muted` : ``));
</script>

<template>
    <span class="flex min-w-0 items-center" :class="chips ? 'flex-wrap gap-1.5' : 'gap-1.5'">
        <span
            class="flex min-w-0 items-center gap-1 text-2xs"
            :class="pill"
            :aria-label="`${t(`shared.model`)}: ${providerLabel(run.provider)} ${run.modelId}`"
        >
            <!-- The provider's own mark on the chip, so the bar needs no chip naming the provider as well. -->
            <ProviderLogo v-if="chips" :provider="run.provider" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 truncate" aria-hidden="true">{{ run.model }}</span>
        </span>
        <span
            v-if="run.effort !== undefined"
            class="flex shrink-0 items-center gap-1 text-2xs"
            :class="pill"
            :aria-label="`${t(`shared.effort`)}: ${run.effort.label}`"
        >
            <!-- The composer's ladder as a picture, small enough for a line of text: the same rungs, lit the same way. -->
            <span v-if="rungs.length > 0" class="flex items-end gap-px" aria-hidden="true">
                <span
                    v-for="(fill, index) in rungs"
                    :key="index"
                    class="h-2 w-0.75 rounded-xs"
                    :class="fill === undefined ? 'bg-content/15' : ''"
                    :style="fill === undefined ? undefined : { backgroundColor: fill }"
                ></span>
            </span>
            <span aria-hidden="true">{{ run.effort.label }}</span>
        </span>
    </span>
</template>
