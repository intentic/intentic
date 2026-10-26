<script setup lang="ts">
import { ResponsiveOverlay, toneInk, toneRim, ui, useDevice } from "@intentic/ui";
import { ref } from "vue";
import { type DriftArea, type DriftKind, KIND_TONE, kindImpact } from "./driftReport";

// One part of the app the two builds disagree about, as a chip in its kind's line (SandboxBehindCard). The chip is the
// name and nothing else: where the part lives, what the gap costs and the internal names wait in its popover, for the
// reader who wants them, instead of under every row of a list.

const { area } = defineProps<{ area: DriftArea }>();

const open = ref(false);
// A phone's sheet already heads itself with the name; the desktop panel has no header of its own.
const { mobile } = useDevice();
const anchor = ref<HTMLElement>();

// Only the kinds this area actually holds, so a drifted-only area doesn't explain what "missing" would have meant.
const kinds = (): readonly DriftKind[] => ([`missing`, `drifted`, `extra`] as const).filter((kind) => area[kind].length > 0);
// Every route this area contributes, in the order the kinds are explained above them.
const evidence = (): readonly string[] => [...area.missing, ...area.drifted, ...area.extra];
</script>

<template>
    <button
        ref="anchor"
        type="button"
        :class="ui.chip({ size: `sm` }, toneRim(KIND_TONE[area.kind], `soft`), area.kind === `missing` && toneInk(KIND_TONE[area.kind]))"
        aria-haspopup="dialog"
        :aria-expanded="open"
        @click="open = !open"
    >
        {{ area.label }}
    </button>
    <ResponsiveOverlay v-model="open" :anchor="anchor" side="bottom" :header="area.label" panel-class="w-80 max-w-[calc(100vw-1rem)] p-3">
        <!-- Spaced here rather than by `panel-class`, which only the desktop panel wears: a phone's sheet gets the same gaps. -->
        <div class="flex flex-col gap-2">
            <div class="flex flex-col gap-0.5">
                <p v-if="!mobile" class="text-sm font-semibold">{{ area.label }}</p>
                <p v-if="area.where !== undefined" class="text-xs text-muted">{{ area.where }}</p>
            </div>
            <p v-for="kind in kinds()" :key="kind" class="text-xs">{{ kindImpact(kind) }}</p>
            <!-- The internal names, last and quietest: what a fix is written against, and what nobody else needs. -->
            <ul class="flex flex-wrap gap-x-3 gap-y-1">
                <li v-for="route in evidence()" :key="route" class="font-mono text-2xs text-subtle">{{ route }}</li>
            </ul>
        </div>
    </ResponsiveOverlay>
</template>
