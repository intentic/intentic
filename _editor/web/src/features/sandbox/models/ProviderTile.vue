<script setup lang="ts">
import { providerSpec } from "@intentic/sandbox-contract";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import type { ModelSourceStanding } from "./modelSources";
import { isFreeTile, LOCAL_TILE, type TileKey, type TileTone } from "./providerGrid";

// One tile of Sandbox ▸ Models' grid: a provider's mark (or this machine's), its name, and one line that says what it
// holds or what is happening with it. Every tile is the same size whatever it says, so the grid reads as a set of peers
// rather than a list whose rows grow with their news. Pressing it opens its panel below the grid, as a persona's tile
// opens its editor; pressing the open one closes it.

const t = useT();

const { tile, selected, line, standing, controls } = defineProps<{
    tile: TileKey;
    selected: boolean;
    line: { readonly text: string; readonly tone: TileTone } | undefined;
    // What its connections are in, drawn as a dot on the mark; nothing connected, no dot.
    standing: ModelSourceStanding | undefined;
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
    live: `text-primary-500`,
    warning: `text-warning`,
    danger: `text-danger`,
} as const satisfies Record<TileTone, string>;
</script>

<template>
    <button
        type="button"
        class="ui-row-select group relative flex size-28 shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl px-1.5"
        :class="{ 'ui-row-select-on': selected }"
        :aria-pressed="selected"
        :aria-controls="controls"
        @click="emit(`select`)"
    >
        <!-- The price, where it is nothing: a corner label rather than the tile's line, so it outlives the first account. -->
        <span
            v-if="isFreeTile(tile)"
            class="absolute right-1.5 top-1.5 rounded bg-success/15 px-1 text-[0.6rem] font-medium leading-4 text-success"
            >{{ t(`connect.connect.free`) }}</span
        >
        <!-- An app-icon square, so a monochrome mark has the same weight as the next one whatever its shape. -->
        <span
            class="relative flex size-10 items-center justify-center rounded-xl bg-card text-xl shadow-sm"
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
        <!-- Always the line's height, said or not, so a tile with news is the size of one without. -->
        <span class="flex h-4 max-w-full items-center">
            <span v-if="line" class="truncate text-[0.65rem] leading-4" :class="LINE[line.tone]">{{ line.text }}</span>
        </span>
    </button>
</template>
