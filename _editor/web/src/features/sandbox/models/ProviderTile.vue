<script setup lang="ts">
import { providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import { Icon, toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ProviderLogo from "../../../parts/providers/ProviderLogo.vue";
import type { ModelSourceStanding } from "./modelSources";
import { isFreeTile, LOCAL_TILE, type TileKey, type TileTone } from "./providerGrid";

// One tile of Sandbox ▸ Models' grid: a provider's mark (or this machine's), its name, and a status line only while
// something is happening with it. Pressing it opens its panel below the grid,
// as a persona's tile opens its editor; pressing the open one closes it.

const t = useT();

const { tile, selected, line, standing, found, controls } = defineProps<{
    tile: TileKey;
    selected: boolean;
    line: { readonly text: string; readonly tone: TileTone } | undefined;
    // What its connections are in, drawn as a dot on the mark; nothing connected, no dot.
    standing: ModelSourceStanding | undefined;
    found: boolean;
    // The panel this tile opens, for assistive tech.
    controls: string;
}>();
const emit = defineEmits<{ select: [] }>();

const name = computed(() => (tile === LOCAL_TILE ? t(`connect.providerGrid.local`) : (providerSpec(tile)?.accountLabel ?? tile)));

// The same four tones a connection row draws, so the tile and the rows behind it agree on what a colour means.
const DOT = {
    attention: `bg-warning`,
    blocked: `bg-danger`,
    ready: `bg-success`,
    waiting: `bg-content/30`,
} as const satisfies Record<ModelSourceStanding, string>;

const LINE = {
    muted: `text-subtle`,
    live: `text-accent`,
    warning: `text-warning`,
    danger: `text-danger`,
} as const satisfies Record<TileTone, string>;
</script>

<template>
    <button
        v-tooltip.top="found ? { title: t(`connect.providerGrid.onThisComputer`), note: t(`connect.connect.foundConnectHint`) } : undefined"
        type="button"
        class="ui-row-select group relative flex w-[5.75rem] shrink-0 flex-col items-center gap-2 rounded-xl px-2 pb-3 pt-6"
        :class="{ 'ui-row-select-on': selected }"
        :aria-pressed="selected"
        :aria-controls="controls"
        :aria-description="found ? t(`connect.connect.foundSignedIn`) : undefined"
        @click="emit(`select`)"
    >
        <div v-if="isFreeTile(tile)" class="absolute inset-x-1.5 top-1.5 h-4">
            <span :class="toneWash(`success`, `absolute left-0 top-0 rounded px-1 text-[0.6rem] font-medium leading-4`)">{{
                t(`connect.connect.free`)
            }}</span>
        </div>
        <span v-if="found" class="absolute right-1.5 top-1.5 flex size-4 items-center justify-center text-xs text-accent" aria-hidden="true">
            <Icon name="desktop" />
        </span>
        <!-- The mark itself, no plate: the provider's logo is what the tile is recognised by. -->
        <span
            class="relative flex shrink-0 items-center justify-center px-1.5 py-1 text-3xl"
            :class="selected ? `text-content` : `text-muted group-hover:text-content`"
        >
            <Icon v-if="tile === LOCAL_TILE" name="cpu" />
            <ProviderLogo v-else :provider="tile" />
            <span
                v-if="standing"
                class="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-canvas"
                :class="DOT[standing]"
                aria-hidden="true"
            />
        </span>
        <span class="w-full truncate text-center text-xs font-medium leading-tight" :class="selected ? `text-content` : `text-muted`">{{
            name
        }}</span>
        <span v-if="line" class="max-w-full truncate text-[0.65rem] leading-4" :class="LINE[line.tone]">{{ line.text }}</span>
    </button>
</template>
