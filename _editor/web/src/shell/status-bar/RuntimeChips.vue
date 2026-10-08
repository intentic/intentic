<script setup lang="ts">
import { toneWash } from "@intentic/ui";
import RailIcon from "../rail/RailIcon.vue";
import type { RuntimeChip } from "./runtimeChips";
import { useRuntimeChips } from "./useRuntimeChips";

// The runtime half of the desktop status bar: one chip per live thing (runtimeChips.ts), glyph, words and count, the
// glyph the same one its rail tile used to draw. A link to its page, except the terminal, which opens and closes its
// panel above the bar, the way Ctrl+` does.

const { chips, toggleTerminal, reachable } = useRuntimeChips();

const chipClass = (chip: RuntimeChip): string[] => [
    `flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 transition-colors`,
    chip.active ? `bg-content/8` : `hover:bg-content/5`,
    chip.tone === `warning`
        ? `text-warning`
        : chip.tone === `success`
          ? `text-success`
          : chip.active
            ? `text-content`
            : `text-muted hover:text-content`,
];
const countClass = (chip: RuntimeChip): string => (chip.tone === undefined ? `bg-content/10 text-content` : toneWash(chip.tone));
</script>

<template>
    <div class="flex min-w-0 items-center gap-0.5 overflow-hidden">
        <template v-for="chip in chips" :key="chip.id">
            <RouterLink
                v-if="chip.to !== undefined"
                :to="chip.to"
                :data-chip="chip.id"
                :class="chipClass(chip)"
                :aria-label="chip.aria"
                :aria-current="chip.active ? `page` : undefined"
                v-tooltip.top="chip.tip"
            >
                <RailIcon :section="chip.id" :label="chip.label" class="shrink-0 text-xs" />
                <span class="truncate">{{ chip.label }}</span>
                <span v-if="chip.count !== undefined" class="min-w-4 shrink-0 rounded-full px-1 text-center tabular-nums" :class="countClass(chip)">{{
                    chip.count
                }}</span>
            </RouterLink>
            <!-- The terminal: a toggle, not a link, since its panel docks here rather than being a page. -->
            <button
                v-else
                type="button"
                :data-chip="chip.id"
                :class="[chipClass(chip), { 'pointer-events-none opacity-40': !reachable }]"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                :aria-pressed="chip.active"
                :aria-label="chip.aria"
                v-tooltip.top="chip.tip"
                @click="toggleTerminal"
            >
                <RailIcon :section="chip.id" :label="chip.label" class="shrink-0 text-xs" />
                <span class="truncate">{{ chip.label }}</span>
                <span v-if="chip.count !== undefined" class="min-w-4 shrink-0 rounded-full px-1 text-center tabular-nums" :class="countClass(chip)">{{
                    chip.count
                }}</span>
            </button>
        </template>
    </div>
</template>
