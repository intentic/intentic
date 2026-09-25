<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { CardChecks, LandCheck } from "./landCheck";
import { brokeLabel, projectName, routingMeta } from "./mainlineView";
import { openLandConversation } from "./openLanded";

// THE ONE PART OF A CARD'S CHECKS THAT IS SPELLED OUT: a red. Its land broke main, or the last check its own turn ran
// failed, and either asks somebody to act, so the board's card says it in words with the conversation that has the red
// one press away. Every other reading is the corner seal's (CardSeal.vue) to draw and to say in its hover: a words row on
// every finished card was the loudest line on it, and it said the most on the cards that asked the least.

const t = useT();

const props = defineProps<{ checks: CardChecks }>();

interface Mark {
    readonly key: string;
    readonly icon: IconName;
    readonly label: string;
    readonly hint: string;
    // The conversation a red was handed to.
    readonly open?: string;
}

const failuresOf = (count: number): string => t(`agents.mainline.failures`, { count }, count);

const brokeMark = (land: LandCheck): Mark => {
    const project = projectName(land.project);
    const failures = land.failures ?? 0;
    const routing = routingMeta(land.routing).words;
    return {
        key: `land`,
        icon: `exclamation-circle`,
        label: brokeLabel(failures, land.routing),
        hint:
            failures > 0
                ? t(`agents.landCheck.brokeHint`, { project, failures: failuresOf(failures), routing })
                : t(`agents.landCheck.brokeHintBare`, { project, routing }),
        ...(land.fixUp === undefined ? {} : { open: land.fixUp }),
    };
};

// Main's verdict first: it is about work already in the tree, the proof only about how the turn left it.
const marks = computed<Mark[]>(() => {
    const { land, proof } = props.checks;
    return [
        ...(land?.kind === `broke` ? [brokeMark(land)] : []),
        ...(proof?.verification === `failing`
            ? [
                  {
                      key: `verification`,
                      icon: `exclamation-circle` as const,
                      label: t(`agents.landCheck.lastCheckFailed`),
                      hint:
                          proof.check === undefined
                              ? t(`agents.landCheck.lastCheckFailedHintBare`)
                              : t(`agents.landCheck.lastCheckFailedHint`, { check: proof.check }),
                  },
              ]
            : []),
    ];
});
</script>

<template>
    <span v-if="marks.length > 0" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-danger">
        <span v-for="mark in marks" :key="mark.key" :data-check="mark.key" class="inline-flex min-w-0 items-center gap-1">
            <span v-tooltip.top="mark.hint" class="inline-flex min-w-0 items-center gap-1">
                <Icon :name="mark.icon" class="shrink-0 text-2xs" />
                <span class="min-w-0 tabular-nums">{{ mark.label }}</span>
            </span>
            <button
                v-if="mark.open !== undefined"
                type="button"
                :class="ui.iconButton(`h-4 w-4`)"
                :aria-label="t(`agents.landCheck.openFixUp`)"
                v-tooltip.top="t(`agents.landCheck.openFixUp`)"
                @click.stop="openLandConversation(mark.open)"
            >
                <Icon name="arrow-right" class="text-2xs" />
            </button>
        </span>
    </span>
</template>
