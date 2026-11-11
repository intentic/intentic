<!-- ONE TOOL TILE AT THE RAIL'S FOOT (RailTools.vue, RailSignals.vue): a glyph quieter and shorter than a section's tile,
     since these are tools at hand rather than places to go, and at most one dot in its corner. No count and no words on the
     rail: the hover card carries them, and the accessible name says them. A link where the tool has a page, else a button. -->
<script setup lang="ts">
import type { Tip } from "@intentic/ui";
import type { IconName } from "@intentic/ui/icons";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import RailIcon from "../RailIcon.vue";

const {
    section,
    to,
    active = false,
    inert = false,
} = defineProps<{
    /** The glyph, by the section id its icon is registered under (RailIcon). */
    section: string;
    /** The glyph for a tool with no section of its own (the wake word, the platform). */
    icon?: IconName | undefined;
    aria: string;
    tip?: Tip | string | undefined;
    /** Where a press goes; absent for a toggle, which emits `press`. */
    to?: RouteLocationRaw | undefined;
    /** Its page is in front, or its panel open. */
    active?: boolean;
    /**
     * The dot: something live (`live`, grey), work going on that the reader was not shown (`busy`, pulsing), waiting on the
     * reader (`warning`), or a good standing state (`success`).
     */
    dot?: `live` | `busy` | `warning` | `success` | undefined;
    /** Can't be pressed right now (the sandbox not answering): drawn faint and taken out of the tab order. */
    inert?: boolean;
    /** The flight's key and group while the rail folds and unrolls (railMorph.ts). */
    railKey: string;
    railInto?: string | undefined;
}>();
const emit = defineEmits<{ press: [] }>();

const DOT = { live: `bg-subtle`, busy: `bg-link motion-safe:animate-pulse`, warning: `bg-warning`, success: `bg-success` } as const;
</script>

<template>
    <component
        :is="to === undefined ? `button` : RouterLink"
        v-bind="to === undefined ? { type: `button`, 'aria-pressed': active, 'aria-disabled': inert || undefined } : { to, 'aria-current': active ? `page` : undefined }"
        class="icon-rail-tile icon-rail-tool ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg transition-colors"
        :class="[active ? `ui-row-select-on text-link` : `text-subtle hover:text-content`, { 'pointer-events-none opacity-40': inert }]"
        :tabindex="inert ? -1 : undefined"
        :data-tool="section"
        :data-rail-key="railKey"
        :data-rail-into="railInto"
        :aria-label="aria"
        v-tooltip.right="tip ?? aria"
        @click="to === undefined && emit(`press`)"
    >
        <RailIcon :section="section" :fallback="icon" class="icon-rail-glyph icon-rail-tool-glyph" />
        <span v-if="dot !== undefined" class="icon-rail-dot absolute rounded-full" :class="DOT[dot]" aria-hidden="true"></span>
    </component>
</template>
