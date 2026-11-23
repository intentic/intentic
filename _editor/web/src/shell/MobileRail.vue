<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { routeShows } from "../lib/routes/links";
import { useTier } from "../client/sandbox/useTier";
import TileMark from "../components/TileMark.vue";
import GettingStartedRing from "../features/gettingStarted/GettingStartedRing.vue";
import TourMark from "../features/tour/TourMark.vue";
import type { MarkStep } from "../features/tour/tourMarks";
import { askForAttention } from "../models/fleet/board/attentionOutside";
import PresenceAvatars from "../workbench/presence/PresenceAvatars.vue";
import { presenceOthers } from "../workbench/presence/usePresence";
import { railBands } from "../workbench/views/registry";
import ViewBadgeChip from "../workbench/views/ViewBadgeChip.vue";
import { RUNNING_MARK_CLASS } from "../workbench/views/viewBadge";
import AccountPanel from "./AccountPanel.vue";
import { useAuth } from "../client/auth/useAuth";
import RailIcon from "./rail/RailIcon.vue";
import PhoneRailMore from "./rail/phone/PhoneRailMore.vue";
import PhoneSandboxTile from "./rail/phone/PhoneSandboxTile.vue";
import { phoneRailFrame } from "./rail/railFrame";
import { useRailSplit } from "./rail/railSplit";
import { tileLabel, useSectionTiles } from "./rail/sectionTiles";

// THE PHONE'S RAIL, down the left of its board the way a chat app keeps its servers beside its channels, and drawn only
// on the board, so a chat or a section keeps the full width of the screen and leaves by its back arrow.
//
// It keeps what the desktop rail keeps (railSplit.ts): the permanent sections, the ones pinned on this phone, and any
// section while it has something to say; the rest is one press behind its More tile (PhoneRailMore.vue), with the box's
// own pages (the terminal, the Sandbox hub, adding a capability). Drawn whole it was thirteen unlabelled tiles in a
// column that scrolled (2026-11-23).
//
// Top to foot: the sandbox (its logo opens the Menu page; once there is more than one sandbox it moves to the sandbox
// bar along the foot, PhoneSandboxBar.vue, and is not drawn twice), who else is here, the sections in their bands, More,
// and at the very foot the account's avatar (AccountPanel.vue, the desktop's own control). No tooltips: a finger raises
// none, so each tile's accessible name carries what its corner marks say (tileLabel).

// Whether the sandbox bar below draws the open sandbox (ShellMobile.vue decides, by how many there are to go to).
const { sandboxInBar = false } = defineProps<{ sandboxInBar?: boolean }>();

const t = useT();
const { user } = useAuth();
const route = useRoute();
const { isGuest } = useTier();

// The Hub's path carries its tab, so the page is what lights it, below it included, in whichever frame.
const isNavActive = (to: string): boolean => routeShows(route, to);

// Agents, the Workspace, Devices and every rail extension, less what the desktop's rail would keep behind More too.
const { tiles } = useSectionTiles();
const { onRailTiles } = useRailSplit(tiles, isNavActive);
const sectionBands = computed(() => railBands(onRailTiles.value, (tile) => tile.id));

// Which getting-started marks a tile carries, as on the desktop rail: the page each step is done on. The Sandbox hub's
// (models) rides the More tile, behind which its page now is (PhoneRailMore.vue).
const RAIL_MARKS = new Map<string, readonly MarkStep[]>([
    [`workspace`, [`work`]],
    [`agents`, [`agent`, `board`, `land`]],
]);
const railMarks = (id: string): readonly MarkStep[] => RAIL_MARKS.get(id) ?? [];

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
        <PhoneSandboxTile v-if="!sandboxInBar" />
        <!-- Who else is connected right now; their names and what they are doing are on the Menu page. -->
        <PresenceAvatars :members="presenceOthers" direction="column" :size="28" />
        <span v-if="!sandboxInBar || presenceOthers.length > 0" class="my-1 icon-rail-divider h-px bg-line" aria-hidden="true"></span>

        <!-- The one run that can grow (a badging extension each), so the one that scrolls if it ever has to. -->
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
            <!-- Every other section, the terminal, the Sandbox hub and adding a capability. -->
            <PhoneRailMore :tiles="tiles" />
        </div>

        <!-- A first run's checklist, until it is done or put away. -->
        <GettingStartedRing v-if="!isGuest" />
        <!-- The account, at the foot as on the desktop (its own `mt-auto`): who is signed in, Settings, sign out. -->
        <AccountPanel v-if="user !== null" />
    </nav>
</template>
