<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ProviderLogo from "../../../chat/accounts/ProviderLogo.vue";
import { effortRungFill } from "../../../chat/models/run-settings/effortScale";
import type { RunLook } from "./childLook";

// WHAT A CHILD RUNS ON: the model by its catalog name and the tier it ran at, drawn on the composer's own ladder
// (EffortMeter) so a child's tier reads the way the reader set their own. The lit rungs say the tier; its word is only
// the ladder's hover, kept off the line. A ladder-less provider has no rungs to draw, so its tier stays a word. On a tray
// row it is a quiet run of text; on the subagent bar, where the composer would say the same thing, each fact is a chip.

const props = defineProps<{
    run: RunLook;
    // The bar's chips, rather than the row's run of text.
    chips?: boolean;
    // Fixed widths for the model and the ladder, so rows stacked in a tray line them up as columns whatever the model's
    // name or however many rungs its provider's ladder has (at most five; a ladder-less tier's word is cut to fit).
    columns?: boolean;
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
            :class="[pill, columns ? 'w-24 shrink-0' : '']"
            :aria-label="`${t(`shared.model`)}: ${providerLabel(run.provider)} ${run.modelId}`"
        >
            <!-- The provider's own mark on the chip, so the bar needs no chip naming the provider as well. -->
            <ProviderLogo v-if="chips" :provider="run.provider" class="shrink-0 text-2xs text-subtle" />
            <span class="min-w-0 truncate" aria-hidden="true">{{ run.model }}</span>
        </span>
        <span
            v-if="run.effort !== undefined"
            class="flex shrink-0 items-center gap-1 text-2xs"
            :class="[pill, columns ? 'w-5' : '']"
            :aria-label="`${t(`shared.effort`)}: ${run.effort.label}`"
            v-tooltip.top="rungs.length > 0 || columns ? run.effort.label : undefined"
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
            <span v-if="rungs.length === 0" class="min-w-0 truncate" aria-hidden="true">{{ run.effort.label }}</span>
        </span>
    </span>
</template>
