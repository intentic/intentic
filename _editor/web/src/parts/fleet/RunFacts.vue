<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ProviderLogo from "../providers/ProviderLogo.vue";
import { effortRungFill } from "../../models/providers/effortScale";
import type { RunLook } from "../../models/fleet/board/childLook";
import { useAudience } from "../../app/useAudience";

// WHAT A CHILD RUNS ON: the model by its catalog name and the tier it ran at, drawn on the composer's own ladder
// (EffortMeter) so a child's tier reads the way the reader set their own. On a tray row it is a quiet run of text, the
// lit rungs saying the tier with its word only the ladder's hover; a ladder-less provider's tier stays a word. On the
// subagent bar, where the composer would say the same thing, it is drawn as the composer draws it: the provider's mark
// and the model's name as its model pill has them, the ladder with its word beside it, and the account that pays.

const props = defineProps<{
    run: RunLook;
    // The bar's composer-like line, rather than the row's run of text.
    bar?: boolean;
    // Fixed widths for the model and the ladder, so rows stacked in a tray line them up as columns whatever the model's
    // name or however many rungs its provider's ladder has (at most five; a ladder-less tier's word is cut to fit).
    columns?: boolean;
}>();

const t = useT();
// Which model ran a child, and at what effort, is a developer's reading: a maker's tray row and bar say neither.
const { maker } = useAudience();

const rungs = computed(() =>
    Array.from({ length: props.run.effort?.rungs ?? 0 }, (_, index) =>
        index <= (props.run.effort?.rung ?? -1) ? effortRungFill(index, props.run.effort?.rungs ?? 0) : undefined,
    ),
);
</script>

<template>
    <!-- The subagent bar: the composer's own controls, as a statement rather than a press. -->
    <span v-if="!maker && bar" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span
            class="flex min-w-0 items-center gap-1.5 text-2xs font-medium text-muted"
            :aria-label="`${t(`shared.model`)}: ${providerLabel(run.provider)} ${run.modelId}`"
        >
            <ProviderLogo :provider="run.provider" class="shrink-0 text-2xs text-link" />
            <span class="min-w-0 truncate" aria-hidden="true">{{ run.model }}</span>
        </span>
        <span v-if="run.effort !== undefined" class="flex shrink-0 items-center gap-1.5" :aria-label="`${t(`shared.effort`)}: ${run.effort.label}`">
            <span v-if="rungs.length > 0" class="flex items-center" aria-hidden="true">
                <span
                    v-for="(fill, index) in rungs"
                    :key="index"
                    class="composer-effort-seg composer-effort-seg-static"
                    :style="fill === undefined ? undefined : { '--effort-rung-fill': fill }"
                ></span>
            </span>
            <span class="text-2xs whitespace-nowrap text-subtle" aria-hidden="true">{{ run.effort.label }}</span>
        </span>
        <span
            v-if="run.account !== undefined"
            class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle"
            :aria-label="`${t(`shared.account`)}: ${run.account}`"
        >
            <Icon name="user" class="shrink-0 text-2xs" aria-hidden="true" />
            <span class="min-w-0 truncate" aria-hidden="true">{{ run.account }}</span>
        </span>
    </span>
    <span v-else-if="!maker" class="flex min-w-0 items-center gap-1.5">
        <span
            class="flex min-w-0 items-center gap-1 text-2xs"
            :class="columns ? 'w-24 shrink-0' : ''"
            :aria-label="`${t(`shared.model`)}: ${providerLabel(run.provider)} ${run.modelId}`"
        >
            <span class="min-w-0 truncate" aria-hidden="true">{{ run.model }}</span>
        </span>
        <span
            v-if="run.effort !== undefined"
            class="flex shrink-0 items-center gap-1 text-2xs"
            :class="columns ? 'w-5' : ''"
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
