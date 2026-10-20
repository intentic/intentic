<script setup lang="ts">
import { SandboxLogo, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useAudience } from "../app/useAudience";
import { useRole } from "../client/sandbox/useRole";
import { useSandbox } from "../client/sandbox/useSandbox";
import TileMark from "../components/TileMark.vue";
import GettingStartedRing from "../features/gettingStarted/GettingStartedRing.vue";
import { sandboxAvailabilityVisual } from "../features/sandbox/overview/availability";
import { useSandboxAttention } from "../features/sandbox/overview/sandboxAttention";
import { useSandboxAvailability } from "../features/sandbox/overview/useSandboxAvailability";
import { useSandboxPlacement } from "../features/sandbox/overview/useSandboxPlacement";
import TourMark from "../features/tour/TourMark.vue";
import type { MarkStep } from "../features/tour/tourMarks";
import { askForAttention } from "../models/fleet/board/attentionOutside";
import { restartRunning } from "../models/sandbox/live/sandboxRestart";
import { sandboxHubPath } from "../models/sandbox/sandboxNav";
import { useWorkspaceTree } from "../models/workspace/tree/useWorkspaceTree";
import PresenceAvatars from "../workbench/presence/PresenceAvatars.vue";
import { presenceOthers } from "../workbench/presence/usePresence";
import { railBands } from "../workbench/views/registry";
import ViewBadgeChip from "../workbench/views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../workbench/views/viewBadge";
import AccountPanel from "./AccountPanel.vue";
import RailIcon from "./rail/RailIcon.vue";
import { phoneRailFrame } from "./rail/railFrame";
import { type SectionTile, tileLabel, useSectionTiles } from "./rail/sectionTiles";

// THE PHONE'S RAIL, down the left of its board the way a chat app keeps its servers beside its channels: every place the
// sandbox has, one press from the screen a phone opens on. It is the desktop rail's column of tiles (iconRail.css,
// sectionTiles.ts), drawn whole, since a phone has no More door to hide the rest behind and nothing to pin; and drawn
// only on the board, so a chat or a section keeps the full width of the screen and leaves by its back arrow.
//
// Top to foot, as on the desktop: the sandbox (its logo opens the Menu page, where sandboxes are switched and what the
// sandbox needs is listed), who else is here, the sections in their bands, the box's own pages, the +, and at the very
// foot the account's avatar (AccountPanel.vue, the desktop's own control). No tooltips:
// a finger raises none, so each tile's accessible name carries what its corner marks say (tileLabel).

const t = useT();
const route = useRoute();
const { canShip, isGuest } = useRole();
const { maker } = useAudience();

// Agents, the Workspace, Devices and every rail extension, banded as the desktop rail bands them.
const { tiles } = useSectionTiles();
const sectionBands = computed(() => railBands(tiles.value, (tile) => tile.id));

// The box rather than the work, as the desktop keeps it under its sandbox switcher: the terminal (ship tier, since a PTY
// is the whole sandbox, and not in plain words) and the sandbox's own pages. Settings is the avatar's, as on the desktop.
const boxTiles = computed<readonly SectionTile[]>(() => [
    ...(canShip.value && !maker.value ? [{ id: `terminal`, to: `/terminal`, label: t(`shared.terminal`), icon: `code` } as const] : []),
    { id: `sandbox`, to: sandboxHubPath(isGuest.value), label: t(`shared.sandboxHub`), icon: `box` },
]);

// Which getting-started marks a tile carries, as on the desktop rail: the page each step is done on.
const RAIL_MARKS = new Map<string, readonly MarkStep[]>([
    [`workspace`, [`work`]],
    [`agents`, [`agent`, `board`, `land`]],
    [`sandbox`, [`models`]],
]);
const railMarks = (id: string): readonly MarkStep[] => RAIL_MARKS.get(id) ?? [];

// The Sandbox hub's path carries its tab, so the prefix is what lights it.
const isNavActive = (to: string): boolean => {
    const path = to.split(`?`)[0] ?? to;
    return route.path === path || route.path.startsWith(`${path}/`);
};

// THE SANDBOX'S TILE. The same three corners as the desktop's switcher: what it needs from its owner (the badge), where
// it runs and whether it answers (the placement mark, inked by the connection), and work under way that ends by
// replacing it (the turning mark).
const sandbox = useSandbox();
const { badge: attentionBadge } = useSandboxAttention();
const restarting = computed(() => restartRunning(sandbox.activeSandboxId.value));
const placement = useSandboxPlacement();
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));
const sandboxLabel = computed(() =>
    [sandbox.active.value?.name, t(`shared.menu`), attentionBadge.value?.tooltip, availabilityVisual.value.label, restarting.value]
        .filter((part) => part !== undefined && part !== ``)
        .join(` · `),
);

// The rail's measures at a finger's size, whatever the desktop rail is set to (railFrame.ts).
const frame = phoneRailFrame();
</script>

<template>
    <nav
        class="icon-rail flex shrink-0 flex-col items-center border-r border-line bg-card"
        :style="[frame, { width: `var(--icon-rail-width)` }]"
        :aria-label="t(`shared.menu`)"
    >
        <!-- The sandbox: its logo, the way to every sandbox and to what this one needs. -->
        <RouterLink
            to="/menu"
            class="icon-rail-tile relative flex items-center justify-center overflow-visible rounded-xl"
            :aria-label="sandboxLabel"
        >
            <span class="flex size-full items-center justify-center overflow-hidden rounded-xl">
                <SandboxLogo :image="sandbox.active.value?.image ?? null" :name="sandbox.active.value?.name" />
            </span>
            <span
                v-if="placement"
                class="icon-rail-mark pointer-events-none absolute bottom-0.5 left-0.5 inline-flex h-[1.6em] w-[1.6em] items-center justify-center rounded-full bg-[color:var(--ui-tile-ground)] leading-none"
                :class="availabilityVisual.inkClass"
                aria-hidden="true"
            >
                <Icon :name="placement.icon" class="text-[0.9em]" />
            </span>
            <ViewBadgeChip :badge="attentionBadge" class="icon-rail-mark pointer-events-none absolute right-0.5 top-0.5" aria-hidden="true" />
            <TileMark
                v-if="restarting !== undefined"
                name="spinner"
                spin
                :class="[RUNNING_MARK_CLASS, `icon-rail-mark pointer-events-none absolute bottom-0.5 right-0.5`]"
            />
        </RouterLink>
        <!-- Who else is connected right now; their names and what they are doing are on the Menu page. -->
        <PresenceAvatars :members="presenceOthers" direction="column" :size="28" />
        <span class="my-1 icon-rail-divider h-px bg-line" aria-hidden="true"></span>

        <!-- The one run that grows (a tile per extension), so the one that scrolls; the sandbox above and the + below stay put. -->
        <div class="icon-rail-nav scrollbar-none flex flex-col items-center overflow-y-auto overscroll-contain">
            <template v-for="(band, at) in sectionBands" :key="band.group.id">
                <span v-if="at > 0" class="icon-rail-band" aria-hidden="true"></span>
                <RouterLink
                    v-for="tile in band.items"
                    :key="tile.to"
                    :to="tile.to"
                    class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg text-muted active:text-content"
                    :class="{ 'ui-row-select-on text-link': isNavActive(tile.to) }"
                    :aria-label="tileLabel(tile)"
                    :aria-current="isNavActive(tile.to) ? `page` : undefined"
                    @click="tile.id === `agents` && isNavActive(tile.to) && askForAttention()"
                >
                    <RailIcon :section="tile.id" :fallback="tile.icon" :label="tile.label" :monogram="tile.monogram" class="icon-rail-glyph" />
                    <!-- The desktop rail's three corners at its one mark size: the badge, work in flight, a standing note. -->
                    <ViewBadgeChip :badge="tile.badge" class="icon-rail-mark absolute right-0.5 top-0.5" aria-hidden="true" />
                    <TileMark
                        v-if="tile.badge?.running !== undefined"
                        name="spinner"
                        spin
                        :class="[RUNNING_MARK_CLASS, `icon-rail-mark absolute bottom-0.5 right-0.5`]"
                    />
                    <TileMark v-if="tile.note" :name="tile.note.icon" class="icon-rail-mark absolute bottom-0.5 left-0.5 text-subtle" />
                    <template v-for="mark in railMarks(tile.id)" :key="mark">
                        <TourMark :step="mark" place="rail" still side="right" class="absolute left-0.5 top-0.5" />
                    </template>
                </RouterLink>
            </template>
            <span class="icon-rail-band" aria-hidden="true"></span>
            <RouterLink
                v-for="tile in boxTiles"
                :key="tile.id"
                :to="tile.to"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors active:bg-overlay active:text-content"
                :aria-label="tile.label"
            >
                <RailIcon :section="tile.id" :fallback="tile.icon" :label="tile.label" class="icon-rail-glyph" />
                <template v-for="mark in railMarks(tile.id)" :key="mark">
                    <TourMark :step="mark" place="rail" still side="right" class="absolute left-0.5 top-0.5" />
                </template>
            </RouterLink>
        </div>

        <!-- A first run's checklist, until it is done or put away. -->
        <GettingStartedRing v-if="!isGuest" />
        <!-- What this sandbox can reach, added here as on the desktop's +; a guest connects nothing. A new agent is the
             board's own floating press, beside this rail. -->
        <RouterLink
            v-if="!isGuest"
            to="/capabilities"
            :class="ui.addTile(`icon-rail-tile rounded-lg`)"
            :aria-label="t(`shell.words.addCapability`)"
        >
            <RailIcon section="capabilities" class="icon-rail-glyph" />
        </RouterLink>
        <!-- The account, at the foot as on the desktop (its own `mt-auto`): who is signed in, Settings, sign out. -->
        <AccountPanel />
    </nav>
</template>
