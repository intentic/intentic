<script setup lang="ts">
import { providerSpec } from "@intentic/sandbox-contract";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import type { ModelSourceStanding } from "./modelSources";
import { isFreeTile, LOCAL_TILE, type TileKey, type TileTone } from "./providerGrid";

// One tile of Sandbox ▸ Models' grid: a provider's mark (or this machine's), its name, a count in the corner when it
// holds any, and a status line only while something is happening with it. Pressing it opens its panel below the grid,
// as a persona's tile opens its editor; pressing the open one closes it.

const t = useT();

const { tile, selected, line, count, standing, controls } = defineProps<{
    tile: TileKey;
    selected: boolean;
    line: { readonly text: string; readonly tone: TileTone } | undefined;
    // Accounts held or models served; the number alone, top-right.
    count: number | undefined;
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
        class="ui-row-select group relative flex w-[4.75rem] shrink-0 flex-col items-center gap-1 rounded-xl px-1 py-2"
        :class="{ 'ui-row-select-on': selected }"
        :aria-pressed="selected"
        :aria-controls="controls"
        @click="emit(`select`)"
    >
        <!-- The price, where it is nothing: a corner label rather than the tile's line, so it outlives the first account. -->
        <span
            v-if="isFreeTile(tile)"
            class="absolute left-1.5 top-1.5 rounded bg-success/15 px-1 text-[0.6rem] font-medium leading-4 text-success"
            >{{ t(`connect.connect.free`) }}</span
        >
        <span
            v-if="count !== undefined"
            class="absolute right-1.5 top-1.5 text-[0.65rem] font-medium leading-4 tabular-nums text-subtle"
            :aria-label="
                tile === LOCAL_TILE
                    ? t(`connect.providerGrid.models`, { count }, count)
                    : t(`connect.modelSources.accounts`, { count }, count)
            "
            >{{ count }}</span
        >
        <!-- The mark itself, no plate: the provider's logo is what the tile is recognised by. -->
        <span
            class="relative flex shrink-0 items-center justify-center text-3xl"
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
