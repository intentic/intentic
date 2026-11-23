<!-- THE PHONE RAIL'S DOOR TO EVERYTHING OFF IT (MobileRail.vue draws it under the section tiles): a tile like the others
     and the sheet it opens. The phone's rail keeps what the desktop's keeps (railSplit.ts): the permanent sections, the
     pinned ones, and any section while it has something to say. Everything else is here, a press away, so the rail never
     scrolls: every section that comes and goes, each with its pin, and the box's own pages (the terminal, the Sandbox
     hub, adding a capability), which a phone opens far less than the board. -->
<script setup lang="ts">
import { type IconName, ResponsiveOverlay, Row, RowGroup, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAudience } from "../../../app/useAudience";
import { useTier } from "../../../client/sandbox/useTier";
import { useHeldDoor } from "../../../components/heldPlace";
import { here, page, routeShows } from "../../../lib/routes/links";
import { sandboxHubPath } from "../../../models/sandbox/sandboxNav";
import { railPolicy } from "../../../workbench/views/registry";
import ViewBadgeChip from "../../../workbench/views/ViewBadgeChip.vue";
import TourMark from "../../../features/tour/TourMark.vue";
import RailIcon from "../RailIcon.vue";
import { useRailPins } from "../railPins";
import type { SectionTile } from "../sectionTiles";

// Every section tile, in rail order (sectionTiles.ts); the sheet keeps the ones a pin decides.
const { tiles } = defineProps<{ tiles: readonly SectionTile[] }>();

const t = useT();
const route = useRoute();
const router = useRouter();
const pins = useRailPins();
const { canShip, isGuest } = useTier();
const { maker } = useAudience();
// Capabilities is a maintainer's page: below that the row is no door (components/heldPlace.ts).
const connects = useHeldDoor(`capabilities.list`);

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const isHere = (to: string): boolean => routeShows(route, to);

// The sections that come and go, alphabetically: the permanent ones never leave the rail, so they have nothing to pin and
// no row. A pinned one is listed too, the only place a phone, with no right-click, can take it off again; one on the
// rail by its badge is listed so it can be kept once the badge goes.
const sections = computed(() =>
    tiles.filter((tile) => railPolicy(tile.id) !== `always`).toSorted((left, right) => left.label.localeCompare(right.label)),
);

interface BoxRow {
    readonly id: string;
    readonly to: string;
    readonly label: string;
    // The glyph where the section icon table has none of its own (RailIcon `fallback`), as the desktop draws them.
    readonly icon?: IconName;
}
// The box rather than the work, as the desktop keeps them by its sandbox switcher: the terminal (ship tier, since a PTY
// is the whole sandbox, and not in plain words), the sandbox's own pages, and what it can reach. Settings is the
// avatar's, as on the desktop.
const boxRows = computed<readonly BoxRow[]>(() => [
    ...(canShip.value && !maker.value ? [{ id: `terminal`, to: here(page.terminal()), label: t(`shared.terminal`), icon: `code` as const }] : []),
    { id: `sandbox`, to: sandboxHubPath(isGuest.value), label: t(`shared.sandboxHub`), icon: `box` },
    ...(connects.value ? [{ id: `capabilities`, to: here(page.capabilities()), label: t(`shell.words.addCapability`) }] : []),
]);

const go = (to: string): void => {
    open.value = false;
    void router.push(to);
};
const pinLabel = (tile: SectionTile): string =>
    pins.isPinned(tile.to) ? t(`shell.mobileRail.unpin`, { label: tile.label }) : t(`shell.shellDesktop.keepOnRail`, { label: tile.label });
</script>

<template>
    <button
        ref="trigger"
        type="button"
        class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg text-muted active:text-content"
        :class="{ 'ui-row-select-on text-link': open }"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-label="t(`shell.shellDesktop.moreSections`)"
        @click="open = true"
    >
        <RailIcon section="more" class="icon-rail-glyph" />
        <!-- Connecting your own models is done on the Sandbox hub, which is behind this tile on a phone. -->
        <TourMark step="models" place="rail" still side="right" class="absolute left-0.5 top-0.5" />
    </button>

    <ResponsiveOverlay
        v-model="open"
        :anchor="trigger ?? undefined"
        :header="t(`shell.shellDesktop.moreSections`)"
        side="right"
        panel-class="w-80 p-1"
    >
        <div class="flex flex-col gap-4 pb-2">
            <!-- Each row is two controls side by side, go there and pin it, never one inside the other. -->
            <RowGroup v-if="sections.length > 0" :label="t(`shell.hubLayout.sections`)">
                <Row
                    v-for="tile in sections"
                    :key="tile.to"
                    header-button
                    interactive
                    :selected="isHere(tile.to)"
                    :title="tile.label"
                    @header-click="go(tile.to)"
                >
                    <template #lead="{ iconClass }">
                        <RailIcon :section="tile.id" :fallback="tile.icon" :label="tile.label" :monogram="tile.monogram" :class="iconClass" />
                    </template>
                    <template v-if="tile.badge" #meta>
                        <ViewBadgeChip :badge="tile.badge" aria-hidden="true" />
                    </template>
                    <template #control>
                        <button
                            type="button"
                            :class="ui.iconButton({ size: `xl`, tone: `subtle` }, pins.isPinned(tile.to) && `text-link`)"
                            :aria-label="pinLabel(tile)"
                            :aria-pressed="pins.isPinned(tile.to)"
                            @click="pins.toggle(tile.to)"
                        >
                            <Icon name="pin" class="text-base" />
                        </button>
                    </template>
                </Row>
            </RowGroup>
            <p v-if="sections.length > 0" class="-mt-2 px-2 text-xs text-subtle">{{ t(`shell.mobileRail.pinNote`) }}</p>

            <RowGroup :label="t(`shared.thisSandbox`)">
                <Row
                    v-for="row in boxRows"
                    :key="row.id"
                    header-button
                    interactive
                    chevron
                    :selected="isHere(row.to)"
                    :title="row.label"
                    @header-click="go(row.to)"
                >
                    <template #lead="{ iconClass }">
                        <RailIcon :section="row.id" :fallback="row.icon" :label="row.label" :class="iconClass" />
                    </template>
                </Row>
            </RowGroup>
        </div>
    </ResponsiveOverlay>
</template>
