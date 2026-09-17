<script setup lang="ts">
import { Button, Icon } from "@intentic/ui";
import { type RouteLocationRaw, RouterLink } from "vue-router";
import type { DeviceConcern } from "./deviceAttention";
import { useT } from "@intentic/ui/i18n";

// One thing a machine wants from the reader, drawn as a line rather than a slab: the glyph says which kind of want
// it is, the sentence carries it, and the one control that closes it sits at the end, where this page keeps its
// actions. The tone tints the edge and the glyph, never the sentence — a paragraph printed entirely in a signal
// colour is harder to read than the fact it is signalling, and these sentences are long enough to need reading.

const t = useT();

const { concern } = defineProps<{
    concern: DeviceConcern;
    /** Where a `card` fix leads; built by the page, since this module holds no router knowledge. */
    route?: RouteLocationRaw;
}>();

const emit = defineEmits<{ connect: [] }>();

// Spelled out per tone, not templated: Tailwind only emits a utility it can see used literally. The two that
// signal keep <Notice>'s own tint, so they are recognisable as the same rank of thing; `info` is a machine state
// rather than a fault and takes the page's own surface, which is what stops a sleeping laptop shouting.
const SURFACE: Record<DeviceConcern[`tone`], string> = {
    info: `border-line-subtle bg-content/5`,
    warning: `border-warning/40 bg-warning/10`,
    danger: `border-danger/40 bg-danger/10`,
};

const GLYPH: Record<DeviceConcern[`tone`], string> = { info: `text-muted`, warning: `text-warning`, danger: `text-danger` };
</script>

<template>
    <!-- `alert` for the tones the reader must act on, `status` for the one they don't, as <Notice> ranks them. -->
    <div
        class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5"
        :class="SURFACE[concern.tone]"
        :role="concern.tone === `info` ? `status` : `alert`"
    >
        <Icon :name="concern.icon" class="shrink-0 text-sm" :class="GLYPH[concern.tone]" aria-hidden="true" />
        <!-- `basis-64`: the control drops to a line of its own below that width instead of squeezing the sentence. -->
        <p class="min-w-0 grow basis-64 text-xs text-muted">
            {{ concern.text }}
            <!-- Kept on one line and in the content ink: a command broken across a wrap can't be copied by eye. -->
            <template v-if="concern.command">
                {{ t(`sandbox.deviceConcern.run`) }}
                <code class="rounded bg-content/10 px-1 py-0.5 font-mono text-2xs whitespace-nowrap text-content">{{ concern.command }}</code>
                {{ t(`sandbox.deviceConcern.onDevice`) }}
            </template>
        </p>
        <!-- A link wearing the button's clothes, since this fix has an address: hoverable and Ctrl/⌘-clickable. -->
        <Button
            v-if="concern.fix?.kind === `card` && route !== undefined"
            :as="RouterLink"
            :to="route"
            size="small"
            severity="secondary"
            :text="true"
            :label="concern.fix.label"
            class="ml-auto shrink-0"
        >
            <template #icon><Icon name="arrow-up-right" /></template>
        </Button>
        <!-- Connect actions request a command for the machine without running one locally. -->
        <Button
            v-else-if="concern.fix?.kind === `connect`"
            size="small"
            severity="secondary"
            :label="concern.fix.label"
            v-tooltip.top="concern.fix.hint"
            class="ml-auto shrink-0"
            @click="emit(`connect`)"
        >
            <template #icon><Icon name="desktop" /></template>
        </Button>
    </div>
</template>
