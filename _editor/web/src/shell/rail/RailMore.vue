<!-- THE FOLDED RAIL'S DOOR TO EVERY SECTION OFF IT (ShellDesktop.vue draws it under the tiles): a tile like the others and
     the list it opens. Unrolled, the same sections are in the bookmark (HomeSectionPicker.vue), where this tile flies
     with the rest (railMorph.ts). -->
<script setup lang="ts">
import { AnchoredOverlay, browserOwnsClick, type Tip, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useAudience } from "../../app/useAudience";
import { useHeldDoor } from "../../components/heldPlace";
import { here, isPage, page, routeShows } from "../../lib/routes/links";
import RailIcon from "./RailIcon.vue";
import { useRailPins } from "./railPins";
import type { SectionTile } from "./sectionTiles";

// What is off the rail at rest, in the order the list draws it (ShellDesktop.vue `moreTiles`).
const { tiles } = defineProps<{ tiles: readonly SectionTile[] }>();

const t = useT();
const route = useRoute();
const pins = useRailPins();
// Plain words gave the rail's + to a new conversation; what it used to open is a row here, for whoever may open it.
const { maker } = useAudience();
const connects = useHeldDoor(`capabilities.list`);
const isNavActive = (to: string): boolean => routeShows(route, to);

// Every offRail section, as real links (so click behaviors work), sorted alphabetically rather than by
// rail rank; each row can pin the section (railPins.ts). Never badges — anything with something to say is already on the rail.
const moreTrigger = ref<HTMLButtonElement | null>(null);
const moreOpen = ref(false);
// The count is the whole point of hovering; phrased like every other tile's label. A `computed`, so it is rebuilt
// when the language changes rather than holding the words it was born with.
const moreLabel = computed(() =>
    tiles.length === 0
        ? t(`shell.shellDesktop.moreSections`)
        : t(`shell.shellDesktop.moreSectionsOffRail`, { count: tiles.length }, tiles.length),
);
const moreTip = computed((): Tip => ({
    title: t(`shell.shellDesktop.moreSections`),
    rows: tiles.length === 0 ? [] : [{ label: t(`shell.shellDesktop.offRail`), value: tiles.length }],
}));
const dismissMore = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        moreOpen.value = false;
    }
};
// Pins here, not from a right-click, since an offRail section has no tile to click; the row leaves as
// it's pressed (that departure is the feedback). Refocuses the door trigger so a keyboard reader isn't stranded.
const keepOnRail = (tile: SectionTile): void => {
    pins.toggle(tile.to);
    moreTrigger.value?.focus();
};
</script>

<template>
    <button
        ref="moreTrigger"
        type="button"
        class="icon-rail-tile ui-row-select ui-row-select-horizontal flex items-center justify-center rounded-lg text-muted hover:text-content"
        :class="{ 'ui-row-select-on text-link': moreOpen }"
        aria-haspopup="menu"
        :aria-expanded="moreOpen"
        data-rail-key="section:more"
        data-rail-into="sections"
        :aria-label="moreLabel"
        v-tooltip.right="moreOpen ? undefined : moreTip"
        @click="moreOpen = !moreOpen"
    >
        <RailIcon section="more" class="icon-rail-glyph" />
    </button>

    <!-- Same overlay as the switcher and account avatar: AnchoredOverlay rows, not PrimeVue's ContextMenu. -->
    <AnchoredOverlay v-model="moreOpen" :anchor="moreTrigger ?? undefined" side="right" cross="start" menu>
        <div class="flex w-48 flex-col gap-0.5 p-1">
            <!-- With every section pinned the menu is empty, and saying only that sent its reader back four times: it
                 says where the way back is too (the tile's own menu, onTileContextMenu). -->
            <template v-if="tiles.length === 0 && !(maker && connects)">
                <p class="px-2 pt-1.5 text-xs text-subtle">{{ t(`shell.shellDesktop.everySectionOnRail`) }}</p>
                <p class="px-2 pb-1.5 text-2xs text-subtle">{{ t(`shell.shellDesktop.howToUnpin`) }}</p>
            </template>
            <!-- Two controls per row — go there, and pin it (keepOnRail) — as siblings, not nested. -->
            <div
                v-for="tile in tiles"
                :key="tile.to"
                class="ui-row-select group flex items-center rounded-md text-xs"
                :class="isNavActive(tile.to) ? 'ui-row-select-on text-link' : 'text-content'"
            >
                <RouterLink
                    :to="tile.to"
                    class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
                    :aria-current="isNavActive(tile.to) ? 'page' : undefined"
                    @click="dismissMore"
                >
                    <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                        <RailIcon
                            :section="tile.id"
                            :fallback="tile.icon"
                            :label="tile.label"
                            class="text-base"
                            :class="isNavActive(tile.to) ? 'text-link' : 'text-muted'"
                        />
                    </span>
                    <span class="min-w-0 flex-1 truncate">{{ tile.label }}</span>
                </RouterLink>
                <!-- Hidden until hover, focus, or a coarse pointer, so it doesn't compete with the row's real job. -->
                <button
                    type="button"
                    :class="[
                        // `transition`, not the recipe's own `transition-colors`, and passed THROUGH it
                        // so twMerge drops the one it replaces: two transition-* utilities on one
                        // element are a conflict CSS settles by stylesheet order rather than by the
                        // order they are written in, and the one that loses here is the fade this
                        // control appears with. The default property list covers colour and opacity
                        // both, which is exactly the pair this button animates.
                        ui.iconButton({ size: `xs`, tone: `subtle` }, `mr-1 transition`),
                        `opacity-0 pointer-coarse:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100`,
                    ]"
                    :aria-label="t(`shell.shellDesktop.keepOnRail`, { label: tile.label })"
                    v-tooltip.top="t(`shell.shellDesktop.pin`)"
                    @click="keepOnRail(tile)"
                >
                    <Icon name="pin" class="text-xs" />
                </button>
            </div>
            <!-- Plain words gave the rail's + to a new conversation; what it used to open stays here, one press in. -->
            <RouterLink
                v-if="maker && connects"
                :to="here(page.capabilities())"
                class="ui-row-select flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs"
                :class="isPage(route, `capabilities`) ? 'ui-row-select-on text-link' : 'text-content'"
                @click="dismissMore"
            >
                <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                    <RailIcon section="capabilities" class="text-base" :class="isPage(route, `capabilities`) ? 'text-link' : 'text-muted'" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{ t(`shell.words.addCapability`) }}</span>
            </RouterLink>
        </div>
    </AnchoredOverlay>
</template>
