<script setup lang="ts">
import type { LandingExtensions } from "@intentic/sandbox-contract/schemas/agents";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// What landing the work turns on, drawn under the review's bar beside what it takes on (ReviewDependencyNotes): each
// workspace extension it carries that is new here, or asks for more than it was approved for. A land is the yes to them
// (the daemon's extensions/landed-extensions.ts), so this is where they are read before the press; the line says what
// each may do, in full on hover once it runs past the width.

const t = useT();

const { extensions } = defineProps<{ extensions: LandingExtensions }>();

// A notice that needs no decision: one line under the bar, no box, so only the bar reads as something to act on.
const NOTE_LINE = `mx-2 mt-1.5 flex shrink-0 items-center gap-1.5 px-2 text-2xs text-muted`;

// Each wording spelled as its own call, so the catalog check can see every message asked for.
const lineOf = (extension: LandingExtensions[number]): string => {
    const powers = extension.powers.join(`; `);
    if (!extension.approvedBefore) {
        return t(`agents.agentReviewPanel.landingTurnsOnExtension`, { id: extension.id, powers });
    }
    return extension.powers.length > 0
        ? t(`agents.agentReviewPanel.landingRepowersExtension`, { id: extension.id, powers })
        : t(`agents.agentReviewPanel.landingReapprovesExtension`, { id: extension.id });
};
const lines = computed(() => extensions.map((extension) => ({ id: extension.id, text: lineOf(extension) })));
</script>

<template>
    <div v-for="line in lines" :key="line.id" :class="NOTE_LINE">
        <Icon name="extensions" class="shrink-0 text-2xs text-info" />
        <span class="min-w-0 flex-1 truncate" v-tooltip.bottom.overflow="line.text">{{ line.text }}</span>
    </div>
</template>
