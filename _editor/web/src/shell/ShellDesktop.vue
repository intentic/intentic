<script setup lang="ts">
import { useHomeCommand } from "./commands/useHomeCommand";
import { masterRail, sandboxBeside } from "../models/home/masterRail";
import { here, isPage, page, routeShows, sameScreen } from "../lib/routes/links";
import { useGettingStarted } from "../features/gettingStarted/useGettingStarted";
import TourMark from "../features/tour/TourMark.vue";
import type { MarkStep } from "../features/tour/tourMarks";
import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract/state/starter";
import { ui, ContextMenu, type TipTone, type TooltipValue } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, onMounted, onUnmounted, provide, ref, watch, watchPostEffect } from "vue";
import { isNavigationFailure, NavigationFailureType, RouterView, useRoute, useRouter } from "vue-router";
import { askForAttention } from "../models/fleet/board/attentionOutside";
import { useTier } from "../client/sandbox/useTier";
import { useHeldDoor } from "../components/heldPlace";
import { useTerminalPanel } from "../models/terminal/useTerminalPanel";
import { CARD_METRICS_KEY, LIVE_METRICS_KEY, useLiveMetrics } from "../models/sandbox/liveMetrics";
import { useCardMetrics } from "../models/fleet/board/metricsCards";
import RailSignals from "./rail/tools/RailSignals.vue";
import RailTools from "./rail/tools/RailTools.vue";
import { useNavigationCommands } from "./commands/useNavigationCommands";
import { useProjectCommands } from "./commands/useProjectCommands";
import { registerBuiltin } from "../workbench/commands/builtinCommands";
import { railBands, railRank, railPolicy, onRailOnlyByVisit } from "../workbench/views/registry";
import ViewBadgeChip from "../workbench/views/ViewBadgeChip.vue";
import { useVocabulary } from "../workbench/views/vocabulary";
import { chatInSidePanel, chatTucked } from "../models/conversations/panel/chatPanelLayout";
import { useShellCommands } from "./commands/useShellCommands";
import { useKeybindings } from "../workbench/commands/useKeybindings";
import { useLayout } from "../workbench/window/useLayout";
import { uiLength } from "../workbench/window/uiScale";
import { useAudience } from "../app/useAudience";
import { startAgent } from "../models/fleet/agentActions";
import { railFrame } from "./rail/railFrame";
import { presenceOthers } from "../workbench/presence/usePresence";
import { usePanels } from "../models/extensions/usePanels";
import { appTargetId } from "../models/preview/previewModel";
import { openPreviewOnFirstVisit } from "../workbench/browsers/browsersSurface";
import AccountPanel from "./AccountPanel.vue";
import MasterRail from "./rail/MasterRail.vue";
import OtherSandboxes from "./rail/OtherSandboxes.vue";
import RailProcesses from "./rail/RailProcesses.vue";
import GettingStartedRing from "../features/gettingStarted/GettingStartedRing.vue";
import { terminalSlot } from "../workbench/window/panelSlots";
import SidePanel from "./side/SidePanel.vue";
import ChatQuickBar from "../features/chat/panel/ChatQuickBar.vue";
import { registerCoreSideViews } from "./side/coreSideViews";
import { setSplit, sideDocked } from "../workbench/side/sideTabs";
import { besideChat, besideFills, sideColumnShown, sideShown, sideTucked, TUCKED_STRIP_PX } from "./side/sideLayout";
import { type RailTile, useRailMemory } from "./rail/railMemory";
import { type SectionTile, tileLabel, tileParts, useSectionTiles } from "./rail/sectionTiles";
import { useRailSplit } from "./rail/railSplit";
import { useRailMorph } from "./rail/railMorph";
import RailIcon from "./rail/RailIcon.vue";
import RailMore from "./rail/RailMore.vue";
import TileMark from "../components/TileMark.vue";
import { RUNNING_MARK_CLASS } from "../workbench/views/viewBadge";
import PresenceAvatars from "../workbench/presence/PresenceAvatars.vue";
import QuickOpen from "./commands/QuickOpen.vue";
import ShortcutSheet from "./commands/ShortcutSheet.vue";
import SandboxGate from "../features/sandbox/gates/SandboxGate.vue";
import SandboxSwitcher from "../features/sandbox/gates/SandboxSwitcher.vue";
import { useT } from "@intentic/ui/i18n";

// The tiles themselves, and every badge on them, are rail/sectionTiles.ts's, shared with the phone's rail.
const t = useT();
// All sandboxes, in place: the rail unrolls around the page on screen, and folds back (commands/useHomeCommand.ts).
useHomeCommand(true);

// The hover: the name alone, or the name as a card's headline over what the tile is carrying. A warning or danger badge
// lends the headline its dot, since that tone marks a standing state rather than a count.
const badgeTone = (tone: ViewBadge[`tone`]): TipTone | undefined => (tone === `warning` ? `warning` : tone === `danger` ? `danger` : undefined);
const tileTip = (tile: SectionTile, extra?: string): TooltipValue => {
    const parts = [...tileParts(tile), ...(extra === undefined ? [] : [extra])];
    if (parts.length === 0) {
        return tile.label;
    }
    const tone = badgeTone(tile.badge?.tone);
    return { title: tile.label, tone, note: parts.join(` · `) };
};

// Desktop chrome of the post-login shell: a square-tile rail, a workspace outlet, and the side panel (the chat and what
// was opened beside), laid out as a three-column grid (the side panel's width via --side-width, written below).
// Shared lifecycle (liveness, presence, plan) lives in WorkspaceShell, which picks this or ShellMobile.

const { panels } = usePanels();
// A guest has no More door and no + (see the rail's foot below).
const { isGuest } = useTier();
const layout = useLayout();
const route = useRoute();
const router = useRouter();
const onHome = computed(() => route.name === `home`);
// The audience's words: the maker's + names a new agent rather than a capability.
const words = useVocabulary();
// A reader who does not write code meets the rail's + as the start of a conversation, which is what they came to do;
// connecting Docker, SSH or a wallet is a maintainer's errand, one press further in and no door for anyone below one.
const { maker } = useAudience();
const connects = useHeldDoor(`capabilities.list`);

// By page, not active-class: a splat param (workspace/:path) drops it once set, and a tile is its page in any frame.
const isNavActive = (to: string): boolean => routeShows(route, to);

// Opens the seeded starter site on a box's very first landing (browsersSurface.ts's once-only flag), waiting
// for /panels to actually name it rather than a timer. Desktop only: a phone has one surface to give up.
watch(
    panels,
    (list) => {
        // Only from the landing route: a reader who opened a different link asked to be there.
        if (isPage(route, `workspace`) && list.some((panel) => panel.repo === STARTER_REPO)) {
            openPreviewOnFirstVisit(router, appTargetId(STARTER_REPO, STARTER_APP));
        }
    },
    { immediate: true },
);

// Every nav tile, on the rail or not, in one run ranked by RAIL_GROUPS (sectionTiles.ts, shared with the phone's rail);
// the on the rail and More lists both come from this run, so a section is never in neither (only the one you are
// visiting is in both). The chat has no tile: it stands at the right of every page (shell/side).
const { tiles, settled: railSettled } = useSectionTiles();

// onRail (registry.ts) holds the rule; railSplit.ts supplies its live facts, pinned and active, as it does the phone's.
const { pins, onRailTiles, moreTiles } = useRailSplit(tiles, isNavActive);

// tileTip, plus one clause when a tile is on the rail only by the visit: says so once, while it can still
// be pinned.
const visitingNote = (tile: SectionTile): string | undefined =>
    onRailOnlyByVisit(tile, { pinned: pins.isPinned(tile.to), active: isNavActive(tile.to) }) ? t(`shell.shellDesktop.rightClickKeep`) : undefined;
const railTileLabel = (tile: SectionTile): string => [tileLabel(tile), visitingNote(tile)].filter((part) => part !== undefined).join(` · `);
const railTileTip = (tile: SectionTile): TooltipValue => tileTip(tile, visitingNote(tile));

const railNav = ref<HTMLElement | null>(null);
// ONE RAIL, FOLDED ONTO A SANDBOX OR UNROLLED ONTO ALL OF THEM (models/home/masterRail.ts). The `nav` stays and what it
// holds changes; the change is played, each sandbox to its tile and each section into the bookmark, or back
// (rail/railMorph.ts), so it reads as one rail rearranging rather than a second screen.
useRailMorph(() => railNav.value, masterRail);

// Only the permanent tiles and this reader's pins — the tiles that will still be there tomorrow.
const stableTiles = computed<readonly SectionTile[]>(() => tiles.value.filter((tile) => railPolicy(tile.id) === `always` || pins.isPinned(tile.to)));
// Tiles the rail had last time and hasn't refilled yet; empty once complete or on a first visit.
const heldTiles = useRailMemory(stableTiles, railSettled);
// On-rail tiles plus held tiles, sorted by the same table, so each lands where it will take its place.
const railTiles = computed<readonly SectionTile[]>(() =>
    [...onRailTiles.value, ...heldTiles.value].toSorted((left, right) => railRank(left.id) - railRank(right.id)),
);
// Held tiles are included so band hairlines don't shift position as the run fills in.
const tileBands = computed(() => railBands(railTiles.value, (tile) => tile.id));

// Alt+Up/Down walks the on the rail nav tiles; wraps, and from a route no tile owns enters at the end the press is
// heading toward.
const cycleSection = (delta: number): void => {
    // The on the rail run only; a section behind More is reached by its own command instead.
    const list = railTiles.value;
    if (list.length === 0) {
        return;
    }
    const index = list.findIndex((tile) => isNavActive(tile.to));
    const from = index === -1 ? (delta > 0 ? -1 : 0) : index;
    const next = list[(from + delta + list.length) % list.length];
    if (next !== undefined) {
        void router.push(next.to);
    }
};

let sectionCommands: readonly Disposable[] = [];
// What the side panel can show of the core's own: a file, the running app.
const coreSideViews = registerCoreSideViews();

onMounted(() => {
    // References opened from here on land in the side panel rather than moving the main area (openBeside).
    sideDocked.value = true;
    sectionCommands = [
        // Follows the tiles: cached views stay useful during a stall, even while live actions wait on reachability.
        registerBuiltin(`view.previousSection`, () => cycleSection(-1)),
        registerBuiltin(`view.nextSection`, () => cycleSection(1)),
    ];
});

onUnmounted(() => {
    sideDocked.value = false;
    for (const disposable of coreSideViews) {
        disposable.dispose();
    }
    for (const disposable of sectionCommands) {
        disposable.dispose();
    }
    sectionCommands = [];
});

// Position the menu beside the rail tile using a synthetic event.
const showBesideRail = (menu: { show: (event: Event) => void } | undefined, event: MouseEvent): void => {
    const tile = event.currentTarget as HTMLElement | null;
    const rail = (tile?.closest(`nav`) ?? tile)?.getBoundingClientRect();
    const top = tile?.getBoundingClientRect().top;
    menu?.show(rail === undefined || top === undefined ? event : new MouseEvent(`click`, { clientX: rail.right, clientY: top }));
};

// A tile's menu offers the pin — permanent tiles get no row, since they're already always on the rail.
const tileMenu = ref<{ show: (event: Event) => void }>();
const menuTile = ref<RailTile>();
const tileMenuItems = computed<MenuItem[]>(() => {
    const tile = menuTile.value;
    if (tile === undefined) {
        return [];
    }
    return [
        {
            label: t(`shell.shellDesktop.keepOnRail2`),
            // States what happens either way, since this is the one place the tile rule is explained.
            hint: pins.isPinned(tile.to) ? t(`shell.shellDesktop.pinnedHint`) : t(`shell.shellDesktop.unpinnedHint`),
            checked: pins.isPinned(tile.to),
            command: (): void => pins.toggle(tile.to),
        },
    ];
});
const onTileContextMenu = (tile: RailTile, event: MouseEvent): void => {
    if (railPolicy(tile.id) === `always`) {
        return; // A permanent tile has nothing to offer here; keep the browser's own menu.
    }
    event.preventDefault();
    menuTile.value = tile;
    showBesideRail(tileMenu.value, event);
};

// The rail's own measures, shared with a desktop window on a local folder (railFrame.ts, iconRail.css).
const railStyle = railFrame();

// THE SIDE COLUMN'S WIDTH IS WRITTEN ONTO THE GRID, NOT DRAWN BY THIS TEMPLATE. It moves on every frame of a drag of the
// chat's edge, and as a template binding each move redrew this whole component, the rail's every tile with it. While
// the edge is dragged it is the chat's live width (useLayout's previewChatWidth), which nothing else reads.
// `--side-width` is registered non-inherited (below): an inherited custom property changed on this root restyled every
// element in the app on every move, most of what a drag cost.
const shellEl = ref<HTMLElement>();
// Folded into its strip, the chat is the strip's width (shell/side/ChatTucked.vue).
const chatColumn = computed(() => (chatTucked.value ? TUCKED_STRIP_PX : (layout.liveChatWidth.value ?? layout.chatWidth.value)));
// Tucked, what was opened is only its strip: beside the chat, or the whole column while the chat lives elsewhere.
const sideWidth = computed(() => {
    if (sideTucked.value) {
        return chatInSidePanel.value ? chatColumn.value + TUCKED_STRIP_PX : TUCKED_STRIP_PX;
    }
    return besideChat.value && !besideFills.value ? chatColumn.value + layout.besideWidth.value : chatColumn.value;
});
watchPostEffect(() => {
    shellEl.value?.style.setProperty(`--side-width`, sideColumnShown.value ? uiLength(sideWidth.value) : `0px`);
});

// Toggled by the rail tile or Ctrl+`; the panel docks below the workspace since sessions are sandbox-global.
const terminal = useTerminalPanel();

// Going to a section (a rail tile, the palette, a link; the section already on screen included) while what was opened
// fills the middle brings the section back beside it, rather than leaving the click with nothing to show. So does the
// terminal, which docks in the section's cell. A query alone changing is the section's own state, not a visit.
const showSection = (): void => {
    if (besideFills.value) {
        setSplit(true);
    }
};
// Nor is the rail unrolling or folding around the page on screen: the same screen at its other address.
const stopSectionVisits = router.afterEach((to, from, failure) => {
    if (failure === undefined ? to.path !== from.path && !sameScreen(to, from) : isNavigationFailure(failure, NavigationFailureType.duplicated)) {
        showSection();
    }
});
onUnmounted(stopSectionVisits);
watch(
    () => terminal.open.value,
    (open) => open && showSection(),
);

// The geek metrics, read once here and handed down (LIVE_METRICS_KEY) to the board's header and cards and to the rail's
// near-a-limit tile, so one reading serves all three. Off, nothing is measured at all (liveMetrics.ts).
const liveMetrics = useLiveMetrics();
provide(LIVE_METRICS_KEY, liveMetrics);
// The same reading folded into the board's cards, so a card and the panel's list say what a whole family holds.
provide(CARD_METRICS_KEY, useCardMetrics(liveMetrics));
// Which getting-started marks a rail tile carries: the page each step is done on. Only the current one draws (TourMark).
const RAIL_MARKS: Readonly<Record<string, readonly MarkStep[]>> = { workspace: [`work`], agents: [`agent`, `board`, `land`] };
const railMarks = (id: string): readonly MarkStep[] => RAIL_MARKS[id] ?? [];
// Registers the shell's built-in palette commands on mount, each with its own keybinding.
useShellCommands();
// One destination per place the shell has: every rail section on the rail or not, every sandbox and settings section.
useNavigationCommands();
// The project scope, by keyboard: one command per repository, and the way back to every project while one is open.
useProjectCommands();
// The single global-shortcut dispatcher: matches any registered command's keybinding to the keystroke.
useKeybindings();
// The getting-started checklist, started with the shell so every mark in every feature has an answer to read
// (features/tour/tourState.ts), whichever screen a first run opens on.
useGettingStarted();
</script>

<template>
    <div ref="shellEl" class="shell grid h-screen overflow-hidden bg-canvas text-content" :style="railStyle">
        <!-- The one rail. Unrolled, its tiles are the sandboxes and its sections are in the bookmark (rail/MasterRail.vue);
             folded, the template below: one sandbox's sections, the others in the cluster under its switcher. -->
        <nav
            ref="railNav"
            class="icon-rail flex flex-col items-center border-r border-line bg-card"
            :data-rail="masterRail ? `unrolled` : `folded`"
            style="grid-area: rail"
        >
            <MasterRail v-if="masterRail" />
            <template v-else>
                <!-- Top of the rail: switch between sandboxes, add one, or manage access. No Home tile above it, by the owner's
                 decision (it came back once already): the way to every sandbox is the others' cluster under it, which
                 unrolls them along this rail and which a guest, fenced out of Home, never sees; then the switcher's own
                 header mark and Mod+Alt+H. -->
                <SandboxSwitcher />
                <OtherSandboxes v-if="!isGuest" />
                <!-- Other members connected right now, live from the daemon's /events roster. -->
                <PresenceAvatars :members="presenceOthers" direction="column" :size="28" />
                <!-- `my-1`, as on the other hairline: with `mb-1` alone this one sat off-centre in its own air. -->
                <span class="my-1 icon-rail-divider h-px bg-line"></span>

                <!-- Bands (Work/Judge/Know) are separated by whitespace, not lines: the one hairline marks the real boundary, identity above the sections. What the sandbox is running is the tools' at the foot, not a band's. -->
                <div class="icon-rail-nav scrollbar-none flex flex-col items-center overflow-y-auto overscroll-contain">
                    <template v-for="(band, at) in tileBands" :key="band.group.id">
                        <!-- Air where a hairline used to be; aria-hidden, since the tiles already carry their own labels. -->
                        <span v-if="at > 0" class="icon-rail-band" aria-hidden="true"></span>
                        <template v-for="tile in band.items" :key="tile.to">
                            <!-- A held tile, not a tile yet (railMemory.ts): draws the glyph it will show, dim, so arrival doesn't shift the tiles below it. -->
                            <span
                                v-if="tile.ghost"
                                class="icon-rail-tile flex items-center justify-center rounded-lg bg-overlay/50 text-muted opacity-40"
                                aria-hidden="true"
                                :data-rail-key="`section:${tile.to}`"
                                data-rail-into="sections"
                            >
                                <RailIcon
                                    :section="tile.id"
                                    :fallback="tile.icon"
                                    :label="tile.label"
                                    :monogram="tile.monogram"
                                    class="icon-rail-glyph"
                                />
                            </span>
                            <RouterLink
                                v-else
                                :to="tile.to"
                                class="icon-rail-tile ui-row-select ui-row-select-horizontal relative flex items-center justify-center rounded-lg text-muted hover:text-content"
                                :class="{ 'ui-row-select-on text-link': isNavActive(tile.to) }"
                                :data-rail-key="`section:${tile.to}`"
                                data-rail-into="sections"
                                :aria-label="railTileLabel(tile)"
                                v-tooltip.right="railTileTip(tile)"
                                @contextmenu="onTileContextMenu(tile, $event)"
                                @click="tile.id === `agents` && isNavActive(tile.to) && askForAttention()"
                            >
                                <RailIcon
                                    :section="tile.id"
                                    :fallback="tile.icon"
                                    :label="tile.label"
                                    :monogram="tile.monogram"
                                    class="icon-rail-glyph"
                                />
                                <!-- Three corners, one scale: `.icon-rail-mark` sets the type size all three are drawn from, so the only thing
     that separates them is the plate — which is the distinction worth seeing, and used to be three sizes. -->
                                <!-- One badge for every tile, core or extension: see SectionTile.badge. -->
                                <ViewBadgeChip :badge="tile.badge" class="icon-rail-mark absolute right-0.5 top-0.5" />
                                <!-- Work in flight behind this tile (ViewBadge.running): its own corner, never the chip. -->
                                <TileMark
                                    v-if="tile.badge?.running !== undefined"
                                    name="spinner"
                                    spin
                                    :class="[RUNNING_MARK_CLASS, `icon-rail-mark absolute bottom-0.5 right-0.5`]"
                                />
                                <!-- Opposite corner from the badge so the two never overlap; muted ink, no tone — it isn't an errand. -->
                                <TileMark v-if="tile.note" :name="tile.note.icon" class="icon-rail-mark absolute bottom-0.5 left-0.5 text-subtle" />
                                <!-- The way to a getting-started step from anywhere: the rail's tile for the page it is done on. The
                                 lowest of a step's places, so the page's own mark takes over once the reader is there. -->
                                <template v-for="mark in railMarks(tile.id)" :key="mark">
                                    <TourMark :step="mark" place="rail" still side="right" class="absolute left-0.5 top-0.5" />
                                </template>
                            </RouterLink>
                        </template>
                    </template>
                </div>

                <!-- Every offRail section; kept outside the scrolling run so it's never scrolled out of sight. -->
                <!-- A door to sections, not an "add one": the same tile as the nav run above it, so the dashed rim is left to the
                 one control on this rail that really does add something. -->
                <!-- Empty for an owner means "everything is on the rail", which is worth a tile and a sentence. Empty for a guest
                 means there is nothing to put there and never will be, so the door itself goes. -->
                <!-- A first run's checklist, until it is done or put away, and what the sandbox needs or is worth knowing for as
                 long as any of that is left (gettingStarted/). -->
                <!-- What runs for the reader meanwhile (a sign-in, this PC's setup, a sandbox's): Home holds their pages. -->
                <RailProcesses v-if="!isGuest" sandbox-rail />
                <GettingStartedRing v-if="!isGuest" />
                <RailMore v-if="!isGuest" :tiles="moreTiles" />

                <!-- Every "add" here writes to the sandbox's own configuration or clones into /work, never platform storage. A
                 guest or anyone below a maintainer connects nothing: what this box can reach is the operator's decision. -->
                <button
                    v-if="!isGuest && maker"
                    type="button"
                    :class="ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`)"
                    data-rail-key="rail:new-agent"
                    :aria-label="words.newAgent"
                    v-tooltip.right="words.newAgent"
                    @click="startAgent()"
                >
                    <Icon name="plus" class="icon-rail-glyph" aria-hidden="true" />
                </button>
                <RouterLink
                    v-else-if="connects"
                    :to="here(page.capabilities())"
                    :class="[
                        ui.addTile(`icon-rail-tile ui-row-select-horizontal rounded-lg hover:bg-overlay`),
                        { 'ui-row-select-on text-link': isPage(route, `capabilities`) },
                    ]"
                    data-rail-key="section:capabilities"
                    data-rail-into="sections"
                    :aria-label="t(`shell.words.addCapability`)"
                    v-tooltip.right="t(`shell.words.addCapability`)"
                >
                    <RailIcon section="capabilities" class="icon-rail-glyph" />
                </RouterLink>

                <!-- The foot, held together at the bottom and growing upward: what this device and Intentic are doing, the
                 sandbox's tools (the terminal and Browsers fixed, a standing state over them only while it holds), then the
                 account, an avatar opening its identity and actions. A tile arriving here moves nothing else on the rail. -->
                <div class="mt-auto flex flex-col items-center" style="gap: var(--icon-rail-gap)">
                    <div class="flex flex-col items-center" style="gap: var(--icon-rail-gap)">
                        <RailSignals />
                        <RailTools />
                    </div>
                    <AccountPanel />
                </div>
            </template>
        </nav>

        <!-- The right-hand column: things opened beside the section, and the chat, unless it is in a window of its own. -->
        <SidePanel v-if="sideShown" v-show="sideColumnShown" />

        <!-- Under what was opened while it fills the middle: hidden and inert, but mounted at its own size, so the section
             comes back as it was left, scrolled where it was. -->
        <main
            :id="!onHome && besideFills ? undefined : `main-content`"
            tabindex="-1"
            class="relative flex min-w-0 flex-col overflow-hidden"
            :class="{ invisible: !onHome && besideFills }"
            :inert="!onHome && besideFills ? true : undefined"
            style="grid-area: workspace"
        >
            <RouterView v-if="onHome" />
            <SandboxGate v-else>
                <div class="min-h-0 flex-1 overflow-auto">
                    <RouterView />
                </div>
                <!-- Inside the gate: a docked terminal stays mounted through a stall, its own recovery keeping scrollback. -->
                <div ref="terminalSlot" class="contents"></div>
            </SandboxGate>
        </main>

        <!-- The tucked chat's scratch pad, floating in the section's own cell: opening it must not reflow the page the reader
             opened it to talk about. Outside the gate, like the chat column: a stalled sandbox is a thing to ask about. -->
        <ChatQuickBar v-if="sandboxBeside" />

        <!-- Portals to body, so it overlays the whole shell regardless of where it sits in the grid. -->
        <QuickOpen />
        <ShortcutSheet />

        <!-- A tile's right-click menu (tileMenuItems): the pin. -->
        <ContextMenu ref="tileMenu" :model="tileMenuItems" :min-width="15" />
    </div>
</template>

<style scoped>
/* Not inherited: written on the shell's root on every frame of a drag of the chat's edge, and an inherited custom
   property changed there restyles every element under it (the root holds over a thousand of them to inherit), where
   this one restyles the grid alone. Measured beside a docked chat: 54ms of style and layout a move, against 4ms. A
   custom property an interaction changes belongs on the element that reads it, registered like this one. */
@property --side-width {
    syntax: "*";
    inherits: false;
}

.shell {
    /* Floor is 0, not the stored width, which was clamped at drag time and could push past a shrunk window. */
    grid-template-columns: var(--icon-rail-width) minmax(0, 1fr) minmax(0, var(--side-width, 22rem));
    /* An explicit row, so a stray element landing in an implicit row can't starve 1fr to zero height. No status bar: what
       the sandbox runs is the rail's foot (rail/tools/), its metrics the board's header (BoardMetrics.vue). */
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: "rail workspace side";
}

/* The rail's own rules (tiles, glyphs, marks, bands) are the shared stylesheet's, shell/rail/iconRail.css. */
</style>
