<script setup lang="ts">
import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import { AnchoredOverlay, browserOwnsClick, ui, ContextMenu, type IconName } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { agentsBadge, agentsScopeNote } from "../features/agents/board/agentsTile";
import { useBrowsersQuery } from "../features/browsers/browsersQuery";
import { useSubagentsQuery } from "../features/chat/subagents/subagentsQuery";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import { useRole } from "../features/sandbox/secrets/useRole";
import { useTerminalPanel } from "../features/terminal/useTerminalPanel";
import { useTerminalActivity } from "../features/terminal/useTerminalActivity";
import { useAreaCommands } from "./commands/useAreaCommands";
import { commandShortcut, registerCommand } from "./commands/useCommands";
import {
    type ActiveExtension,
    activationBadge,
    detectActivations,
    extensionPath,
    railBands,
    railRank,
    railSeated,
    seatPolicy,
    seatedOnlyByVisit,
} from "../core-views/registry";
import { badgeClass, badgeText } from "../core-views/viewBadge";
import { chatOnRail, lastAreaPath, toggleChatFloating, toggleChatHome } from "../features/chat/panel/chatPanelLayout";
import { useChatFloating } from "../features/chat/panel/chatFloating";
import { useShellCommands } from "./commands/useShellCommands";
import { useKeybindings } from "./commands/useKeybindings";
import { useLayout } from "./window/useLayout";
import { uiLength } from "./window/uiScale";
import { ICON_RAIL_WIDTH_REM, useIconRailSize } from "./rail/useIconRailSize";
import { presenceOthers } from "./presence/usePresence";
import { usePanels } from "../features/extensions/usePanels";
import { appTargetId, previewEvidence, previewHealthyCount } from "../features/preview/previewModel";
import { openPreviewOnFirstVisit } from "../features/preview/previewSurface";
import { usePublicOutbox } from "../features/workspace/push/usePublicOutbox";
import { outgoingMark, outgoingSummary } from "../features/workspace/push/outgoingWork";
import { useChanges } from "../features/workspace/changes/useChanges";
import { pushBadge } from "../features/workspace/push/pushBadge";
import { usePushFlow } from "../features/workspace/push/usePushFlow";
import { usePorts } from "../features/sandbox/environment/usePorts";
import { useSandbox } from "../features/sandbox/client/useSandbox";
import { useVpn } from "../features/sandbox/devices/useVpn";
import { extensionsLoaded } from "../extension-host/loader";
import AccountPanel from "./AccountPanel.vue";
import { chatDock, terminalDock } from "./window/dockSlots";
import { type RailSeat, useRailMemory } from "./rail/railMemory";
import { useRailPins } from "./rail/railPins";
import RailIcon from "./rail/RailIcon.vue";
import PresenceAvatars from "./presence/PresenceAvatars.vue";
import QuickOpen from "./commands/QuickOpen.vue";
import SandboxGate from "../features/sandbox/gates/SandboxGate.vue";
import SandboxSwitcher from "../features/sandbox/gates/SandboxSwitcher.vue";

// A rail element; the identity half (id, route, label, icon) is RailSeat, shared with the rail's memory.
// - id: the tile's own name or contributing extension's id — what RAIL_GROUPS ranks and groups by.
// - icon: undefined for a repository tile, which renders initials instead.
interface AreaTile extends RailSeat {
    // Same shape core areas and extensions both fill, so the rail renders one badge element.
    readonly badge?: ViewBadge;
    // A standing fact about the tile (not news); today only the Agents tile's cross-sandbox scope uses it.
    readonly note?: { readonly icon: IconName; readonly text: string };
    // Set on a held seat for a tile not yet loaded: dim, inert, never badged (railMemory.ts).
    readonly ghost?: boolean;
}

// One label per tile — name, badge tooltip, then note (news before standing facts). A badge has no
// tooltip of its own: nesting one inside the tile's would open two overlapping boxes on hover.
const tileLabel = (tile: AreaTile): string => [tile.label, tile.badge?.tooltip, tile.note?.text].filter((part) => part !== undefined).join(` · `);

// Desktop chrome of the post-login shell: a square-tile rail, the shared chat panel, and a workspace
// outlet, laid out as a three-column grid (chat width via the --chat-width var, set by its drag handle).
// Shared lifecycle (liveness, presence, plan) lives in WorkspaceShell, which picks this or ShellMobile.

const { panels, settled: panelsSettled } = usePanels();
const { capabilities, settled: capabilitiesSettled } = useCapabilities();
// Always-on, loosely polled, so the tile appears mid-turn; the view polls tighter once it's open.
const { sessions: browsers } = useBrowsersQuery();
// Same loose always-on poll, for the same reason: the tile must appear the moment a turn delegates.
const { sessions: subagents, running: runningSubagents } = useSubagentsQuery();
const { reachable } = useSandbox();
// Uncommitted changes badge the Workspace tile, so the count is visible from any area.
const changes = useChanges();
// A push started and left behind also surfaces: the tile is its only presence outside the panel.
const pushFlow = usePushFlow();
// Agents' badge (agentsTile.ts) covers whichever sandboxes the board reads; also used by the phone tab bar.
const layout = useLayout();
const { iconRailSize } = useIconRailSize();
// When chat floats, this column collapses everywhere else; the panel itself mounts above the router.
const { floats: chatFloats } = useChatFloating();
const route = useRoute();
const router = useRouter();

// Shown only while a tunnel is connected; an always-present badge would say nothing.
const { connected: connectedVpns } = useVpn();
const vpnLabel = computed(() =>
    connectedVpns.value.length === 1
        ? `VPN connected: ${connectedVpns.value[0]?.id}`
        : `${connectedVpns.value.length} VPNs connected: ${connectedVpns.value.map((link) => link.id).join(`, `)}`,
);

// Same idea as the VPN badge: visible everywhere, not only on the Ports tab.
const { forwarded: forwardedPorts } = usePorts();
const forwardedLabel = computed(() =>
    forwardedPorts.value.length === 1
        ? `Port ${forwardedPorts.value[0]?.port} is publicly reachable`
        : `${forwardedPorts.value.length} ports are publicly reachable: ${forwardedPorts.value.map((entry) => entry.port).join(`, `)}`,
);

// Prefix match, not active-class: a splat/optional param (workspace/:path) drops it once one is set.
const isNavActive = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);

// Mirrors the panel's own priority: uncommitted count (size matters) before an outgoing push (a glyph,
// since size doesn't); a push in flight comes first, being this tile's only sign of it.
const workspaceBadge = computed<ViewBadge | undefined>(() => {
    const push = pushBadge(pushFlow.stage.value, pushFlow.question.value);
    if (push !== undefined) {
        return push;
    }
    if (changes.count.value > 0) {
        return {
            count: changes.count.value,
            tooltip: `${changes.count.value} uncommitted ${changes.count.value === 1 ? `change` : `changes`}`,
        };
    }
    const work = changes.outgoing.value;
    if (work === undefined) {
        return undefined;
    }
    return { mark: outgoingMark(work), tooltip: outgoingSummary(work) };
});

// Seated only while chat is docked and not floated, except briefly after popping out from /chat itself.
const chatTileSeated = computed(() => chatOnRail.value && (!chatFloats.value || route.name === `chat`));

/* Preview closes the Work band: start a turn (Chat), read what it did (Agents/Workspace), LOOK at the running
 * app. Evidence-driven like every extension tile: it appears once the workspace has anything a live iframe can
 * show (a runnable repo, a monorepo's apps, a forwarded port, a served public page) and is absent on a box with
 * none, where it could only open an empty state. The badge counts what is actually ANSWERING right now:
 * neutral, because "your app is up"
 * is inventory, not a debt (viewBadge.ts).
 *
 * BOTH READINGS COME FROM THE PANEL'S OWN BUILDERS (previewModel.railTargets), never from a second opinion
 * about what counts as previewable. The first cut of this tile had one: it counted a monorepo as evidence while
 * the panel only listed such a repo's `_apps/` instances, so a monorepo whose root `dev` runs turbo: with no
 * `_apps/` at all: badged "1 running" over a screen saying there was nothing to preview. */
const { files: publicFiles } = usePublicOutbox();
const previewTile = computed<AreaTile | undefined>(() => {
    if (!previewEvidence(panels.value, forwardedPorts.value, publicFiles.value)) {
        return undefined;
    }
    const healthy = previewHealthyCount(panels.value, forwardedPorts.value, publicFiles.value);
    return {
        id: `preview`,
        to: `/preview`,
        label: `Preview`,
        icon: `eye`,
        ...(healthy > 0 ? { badge: { count: healthy, tone: `neutral` as const, tooltip: `${healthy} running` } } : {}),
    };
});

// Opens the seeded starter site on a box's very first landing (previewSurface's once-only flag), waiting
// for /panels to actually name it rather than a timer. Desktop only: a phone has one surface to give up.
watch(
    panels,
    (list) => {
        // Only from the landing route: a reader who opened a different link asked to be there.
        if (route.name === `workspace` && list.some((panel) => panel.repo === STARTER_REPO)) {
            openPreviewOnFirstVisit(router, appTargetId(STARTER_REPO, STARTER_APP));
        }
    },
    { immediate: true },
);

// The always-present tiles plus evidence-driven Preview; extension tiles are added separately below,
// one per activation. Sandbox management lives behind the switcher chip, not a rail tile.
const fixedTiles = computed<readonly AreaTile[]>(() => [
    // First in the Work band; unbadged, since the Agents tile below carries the debt (see chatTileSeated).
    ...(chatTileSeated.value
        ? [
              {
                  id: `chat`,
                  to: `/chat`,
                  label: `Chat`,
                  icon: `comments` as IconName,
              },
          ]
        : []),
    {
        id: `agents`,
        to: `/agents`,
        label: `Agents`,
        // RailIcon draws by area identity; these generic names remain the fallback vocabulary.
        icon: `robot`,
        // Both come from agentsTile.ts, shared with the phone tab bar; the note names the scope when it's wide.
        ...(agentsBadge.value === undefined ? {} : { badge: agentsBadge.value }),
        ...(agentsScopeNote.value === undefined ? {} : { note: { icon: `boxes` as IconName, text: agentsScopeNote.value } }),
    },
    {
        id: `workspace`,
        to: `/workspace`,
        label: `Workspace`,
        icon: `file-tree`,
        ...(workspaceBadge.value === undefined ? {} : { badge: workspaceBadge.value }),
    },
    ...(previewTile.value === undefined ? [] : [previewTile.value]),
]);
/* Browsers appears the moment a turn opens one and stays while the daemon still lists it: a rail tile that
 * tracks live work rather than a permanent surface. It renders in the rail's live-runtime cluster (next to the
 * ports indicator and the terminal), not among the navigation tiles: a browser session is runtime state like a
 * tmux session, not an area like Agents or Workspace. The badge counts RUNNING browsers only: a finished one is
 * still readable in the view (its pages are the record of where the agent went) but it is not something
 * happening now, and a rail count that never drops to zero stops meaning anything. */
const browserTile = computed<AreaTile | undefined>(() => {
    if (browsers.value.length === 0) {
        return undefined;
    }
    const live = browsers.value.filter((session) => session.running).length;
    const helping = browsers.value.filter((session) => session.help !== undefined).length;
    return {
        id: `browsers`,
        to: `/browsers`,
        label: `Browsers`,
        icon: `desktop`,
        // Neutral: an open browser is inventory, not a debt; warning only when the agent is waiting on the user.
        ...(helping > 0
            ? { badge: { count: helping, tone: `warning` as const, tooltip: `the agent needs your help` } }
            : live > 0
              ? { badge: { count: live, tone: `neutral` as const, tooltip: `${live} open` } }
              : {}),
    };
});
// Same shape as browserTile: appears once a turn starts a subagent, badging only the ones still
// working — the third of three things a turn can spawn (shell, browser, agent).
const subagentTile = computed<AreaTile | undefined>(() => {
    if (subagents.value.length === 0) {
        return undefined;
    }
    const live = runningSubagents.value.length;
    return {
        id: `subagents`,
        to: `/subagents`,
        label: `Subagents`,
        icon: `users`,
        // Neutral, as with browsers: a subagent still working is the turn's own doing, not an errand.
        ...(live > 0 ? { badge: { count: live, tone: `neutral` as const, tooltip: `${live} still working` } } : {}),
    };
});
// Same AreaTile shape as the nav tiles, so badges render through one path instead of per hand-rolled link.
const runtimeTiles = computed<readonly AreaTile[]>(() => [browserTile.value, subagentTile.value].filter((tile) => tile !== undefined));
// RailIcon selects bespoke glyphs by view id and validates extension fallbacks before drawing them.
const extensionTile = (active: ActiveExtension): AreaTile => {
    const { extension, activation } = active;
    const badge = activationBadge(active);
    return {
        id: extension.id,
        to: extensionPath(extension, activation),
        label: activation.title,
        ...(activation.icon === undefined ? {} : { icon: activation.icon as IconName }),
        ...(badge === undefined ? {} : { badge }),
    };
};
// Every nav tile, seated or not, in one run ranked by RAIL_GROUPS (core areas, then one tile per
// extension activation); the seated and More lists both come from this run, so an area is never in both or neither.
const tiles = computed<readonly AreaTile[]>(() =>
    [
        ...fixedTiles.value,
        ...detectActivations(panels.value, capabilities.value)
            // Only rail-surface extensions get a tile; per-repo panels open from the Workspace tree instead.
            .filter(({ extension }) => extension.surface === `rail`)
            .map(extensionTile),
    ].toSorted((left, right) => railRank(left.id) - railRank(right.id)),
);
// True once extensions, panels, and capabilities have all loaded; before that a missing tile is only late.
const railSettled = computed(() => extensionsLoaded.value && panelsSettled.value && capabilitiesSettled.value);

// railSeated (registry.ts) holds the rule; this only supplies the live facts: pinned and active.
const pins = useRailPins();
const seatedTiles = computed<readonly AreaTile[]>(() =>
    tiles.value.filter((tile) => railSeated(tile, { pinned: pins.pinned.value.has(tile.to), active: isNavActive(tile.to) })),
);
const moreTiles = computed<readonly AreaTile[]>(() =>
    tiles.value.filter((tile) => !seatedTiles.value.includes(tile)).toSorted((left, right) => left.label.localeCompare(right.label)),
);

// tileLabel, plus one clause when a tile is seated only by the visit: says so once, while it can still
// be pinned. Not used by the runtime cluster below — those tiles can't be pinned at all.
const railTileLabel = (tile: AreaTile): string => {
    const visiting = seatedOnlyByVisit(tile, { pinned: pins.isPinned(tile.to), active: isNavActive(tile.to) });
    return visiting ? `${tileLabel(tile)} · here while you are · right-click to keep` : tileLabel(tile);
};

// Only the permanent tiles and this reader's pins — the seats that will still be there tomorrow.
const stableSeats = computed<readonly AreaTile[]>(() =>
    tiles.value.filter((tile) => seatPolicy(tile.id) === `always` || pins.pinned.value.has(tile.to)),
);
// Seats the rail had last time and hasn't refilled yet; empty once complete or on a first visit.
const heldSeats = useRailMemory(stableSeats, railSettled);
// Seated tiles plus held seats, sorted by the same table, so each lands in the seat its tile will take.
const railSeats = computed<readonly AreaTile[]>(() =>
    [...seatedTiles.value, ...heldSeats.value].toSorted((left, right) => railRank(left.id) - railRank(right.id)),
);
// Held seats are included so band hairlines don't shift position as the run fills in.
const tileBands = computed(() => railBands(railSeats.value, (tile) => tile.id));

// Alt+Up/Down walks the seated nav tiles only (the runtime cluster's length changes under a running
// turn); wraps, and from a route no tile owns enters at the end the press is heading toward.
const cycleArea = (delta: number): void => {
    // The seated run only; an area behind More is reached by its own command instead.
    const list = seatedTiles.value;
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

let areaCommands: readonly Disposable[] = [];

onMounted(() => {
    areaCommands = [
        // Follows the tiles: cached views stay useful during a stall, even while live actions wait on reachability.
        registerCommand({
            owner: `builtin`,
            command: `view.previousArea`,
            title: `Previous Rail Area`,
            icon: `chevron-up`,
            keybinding: `Alt+ArrowUp`,
            handler: () => cycleArea(-1),
        }),
        registerCommand({
            owner: `builtin`,
            command: `view.nextArea`,
            title: `Next Rail Area`,
            icon: `chevron-down`,
            keybinding: `Alt+ArrowDown`,
            handler: () => cycleArea(1),
        }),
    ];
});

onUnmounted(() => {
    for (const disposable of areaCommands) {
        disposable.dispose();
    }
    areaCommands = [];
});

// Tracks the last non-chat path, not browser history, which may start on /chat itself (a reload, a link).
watch(
    () => route.path,
    (path) => {
        if (!path.startsWith(`/chat`)) {
            lastAreaPath.value = path;
        }
    },
    { immediate: true },
);

// Hangs the menu off the rail's right edge, level with the tile, instead of PrimeVue's default pointer
// position (wrong for a tile this narrow). A synthetic MouseEvent, since `show` calls preventDefault/stopPropagation on
// it.
const showBesideRail = (menu: { show: (event: Event) => void } | undefined, event: MouseEvent): void => {
    const tile = event.currentTarget as HTMLElement | null;
    const rail = (tile?.closest(`nav`) ?? tile)?.getBoundingClientRect();
    const top = tile?.getBoundingClientRect().top;
    menu?.show(rail === undefined || top === undefined ? event : new MouseEvent(`click`, { clientX: rail.right, clientY: top }));
};

// Two menus: the chat tile offers where it goes next (dock/float, same toggles as elsewhere); every
// other seated tile offers the pin — permanent tiles get no row, since they're already always seated.
const tileMenu = ref<{ show: (event: Event) => void }>();
const menuTile = ref<RailSeat>();
const tileMenuItems = computed<MenuItem[]>(() => {
    const tile = menuTile.value;
    if (tile === undefined) {
        return [];
    }
    if (tile.id === `chat`) {
        return [
            {
                label: `Dock chat back to the side`,
                shortcut: commandShortcut(`chat.toggleHome`),
                command: (): void => toggleChatHome(router),
            },
            {
                label: chatFloats.value ? `Dock chat back` : `Move chat into new window`,
                shortcut: commandShortcut(`chat.toggleFloating`),
                command: (): void => toggleChatFloating(),
            },
        ];
    }
    return [
        {
            label: `Keep on the rail`,
            // States what happens either way, since this is the one place the seat rule is explained.
            hint: pins.isPinned(tile.to) ? `Always seated, badge or not` : `Otherwise it shows only when it needs you`,
            checked: pins.isPinned(tile.to),
            command: (): void => pins.toggle(tile.to),
        },
    ];
});
const onTileContextMenu = (tile: RailSeat, event: MouseEvent): void => {
    if (tile.id !== `chat` && seatPolicy(tile.id) === `always`) {
        return; // A permanent tile has nothing to offer here; keep the browser's own menu.
    }
    event.preventDefault();
    menuTile.value = tile;
    showBesideRail(tileMenu.value, event);
};

// Every unseated area, as real links (so click behaviors work), sorted alphabetically rather than by
// rail rank; each row can pin the area (railPins.ts). Never badges — anything with something to say is already seated.
const moreTrigger = ref<HTMLButtonElement | null>(null);
const moreOpen = ref(false);
// The count is the whole point of hovering; phrased like every other tile's label.
const moreLabel = computed(() => (moreTiles.value.length === 0 ? `More areas` : `More areas · ${moreTiles.value.length} not on the rail`));
const dismissMore = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        moreOpen.value = false;
    }
};
// Pins here, not from a right-click, since an unseated area has no tile to click; the row leaves as
// it's pressed (that departure is the feedback). Refocuses the door trigger so a keyboard reader isn't stranded.
const keepOnRail = (tile: AreaTile): void => {
    pins.toggle(tile.to);
    moreTrigger.value?.focus();
};

// Chat column collapses to 0 whenever the panel doesn't live in it (floated, mid-restore, or homed on
// the rail). Rail measures divide out --ui-scale (`rail()`): chrome doesn't grow with the app's text size.
const rail = (value: string): string => `calc(${value} / var(--ui-scale))`;
const gridStyle = computed(() => {
    const compact = iconRailSize.value === `compact`;
    return {
        "--chat-width": chatFloats.value || chatOnRail.value ? `0px` : uiLength(layout.chatWidth.value),
        "--icon-rail-width": rail(`${ICON_RAIL_WIDTH_REM[iconRailSize.value]}rem`),
        "--icon-rail-tile-size": rail(compact ? `2.5rem` : `2.75rem`),
        "--icon-rail-account-size": rail(compact ? `2rem` : `2.25rem`),
        "--icon-rail-divider-width": rail(compact ? `1.75rem` : `2rem`),
        "--icon-rail-gap": rail(compact ? `0.375rem` : `0.5rem`),
        "--icon-rail-padding": rail(compact ? `0.5rem` : `0.75rem`),
    };
});

// Toggled by the rail tile or Ctrl+`; the panel docks below the workspace since sessions are sandbox-global.
const terminal = useTerminalPanel();
// Ship-tier only: a PTY is the whole sandbox, and the daemon refuses the socket below maintainer anyway.
const { canShip } = useRole();
// The only affordance for the panel now; the Workspace view's own toggle is gone, since terminals are
// sandbox-global. Doubles as an indicator: the badge counts live sessions, the tooltip names them.
const terminalActivity = useTerminalActivity();
const terminalLabel = computed(() => {
    const chord = commandShortcut(`terminal.toggle`);
    const what = terminalActivity.summary.value === undefined ? `Terminal` : `Terminal, ${terminalActivity.summary.value} running`;
    return chord === undefined ? what : `${what} (${chord})`;
});
// Registers the shell's built-in palette commands on mount, each with its own keybinding.
useShellCommands();
// One "Go to <area>" per rail area, seated or not, so a More-menu area stays a keystroke away.
useAreaCommands();
// The single global-shortcut dispatcher: matches any registered command's keybinding to the keystroke.
useKeybindings();
</script>

<template>
    <div class="shell grid h-screen overflow-hidden bg-canvas text-content" :style="gridStyle">
        <nav class="icon-rail flex flex-col items-center border-r border-line bg-card" style="grid-area: rail">
            <!-- Top of the rail: switch between sandboxes, add one, or manage access. -->
            <SandboxSwitcher />
            <!-- Other members connected right now, live from the daemon's /events roster. -->
            <PresenceAvatars :members="presenceOthers" direction="column" :size="28" />
            <span class="mb-1 icon-rail-divider h-px bg-line"></span>

            <!--
                Bands (Work/Judge/Know) are separated by whitespace, not lines: hairlines mark only the two real
                boundaries — identity, work areas, live runtime. Stays live through a daemon catch-up; cached views still work.
            -->
            <div class="icon-rail-nav scrollbar-none flex flex-col items-center overflow-y-auto overscroll-contain">
                <template v-for="(band, at) in tileBands" :key="band.group.id">
                    <!-- Air where a hairline used to be; aria-hidden, since the tiles already carry their own labels. -->
                    <span v-if="at > 0" class="icon-rail-band" aria-hidden="true"></span>
                    <template v-for="tile in band.items" :key="tile.to">
                        <!--
                            A held seat, not a tile yet (railMemory.ts): draws the glyph it will show, dim, so arrival doesn't
                            shift the tiles below it. Not focusable or announced — there's nothing here to act on.
                        -->
                        <span
                            v-if="tile.ghost"
                            class="icon-rail-tile flex items-center justify-center rounded-lg bg-overlay/50 text-muted opacity-40"
                            aria-hidden="true"
                        >
                            <RailIcon :area="tile.id" :fallback="tile.icon" :label="tile.label" class="text-[1.375rem]" />
                        </span>
                        <RouterLink
                            v-else
                            :to="tile.to"
                            class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                            :class="{ 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                            :aria-label="railTileLabel(tile)"
                            v-tooltip.right="railTileLabel(tile)"
                            @contextmenu="onTileContextMenu(tile, $event)"
                        >
                            <RailIcon :area="tile.id" :fallback="tile.icon" :label="tile.label" class="text-[1.375rem]" />
                            <!-- One badge for every tile, core or extension: see AreaTile.badge. A `mark` replaces
                                 the number outright rather than sitting beside it: the chip is four pixels of
                                 glance, and a glyph AND a digit in it would be two claims competing for the same
                                 read. No tooltip of its own either: it would nest inside the tile's and open a
                                 second box on top of it: its sentence rides the tile instead (see tileLabel). -->
                            <span
                                v-if="tile.badge"
                                class="absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
                                :class="badgeClass(tile.badge)"
                            >
                                <Icon v-if="tile.badge.mark !== undefined" :name="tile.badge.mark as IconName" />
                                <template v-else>{{ badgeText(tile.badge) }}</template>
                            </span>
                            <!--
                                Opposite corner from the badge so the two never overlap; muted ink, no plate — it isn't an errand.
                                Hidden from assistive tech: its text is already in the tile's aria-label (see railTileLabel).
                            -->
                            <span v-if="tile.note" class="absolute bottom-0.5 left-0.5 flex leading-none text-subtle" aria-hidden="true">
                                <Icon :name="tile.note.icon" class="text-[0.6rem]" />
                            </span>
                        </RouterLink>
                    </template>
                </template>
            </div>

            <!--
                Every unseated area; kept outside the scrolling run so it's never scrolled out of sight. Dashed like
                the "+" below it (both are doors); no hover label while its menu is open, since they'd overlap.
            -->
            <button
                ref="moreTrigger"
                type="button"
                :class="[ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`), { 'border-link bg-primary-600/15 text-link': moreOpen }]"
                aria-haspopup="menu"
                :aria-expanded="moreOpen"
                :aria-label="moreLabel"
                v-tooltip.right="moreOpen ? undefined : moreLabel"
                @click="moreOpen = !moreOpen"
            >
                <RailIcon area="more" class="text-[1.375rem]" />
            </button>

            <!-- Same overlay as the switcher and account avatar: AnchoredOverlay rows, not PrimeVue's ContextMenu. -->
            <AnchoredOverlay v-model="moreOpen" :anchor="moreTrigger ?? undefined" side="right" cross="start">
                <div class="flex w-48 flex-col gap-0.5 p-1">
                    <p v-if="moreTiles.length === 0" class="px-2 py-1.5 text-xs text-subtle">Every area is on the rail</p>
                    <!--
                        Two controls per row — go there, and pin it (keepOnRail) — as siblings, not nested, since a link
                        can't contain a button without losing its own click-modifier and copy-link. Hover fill covers the wrapper.
                    -->
                    <div
                        v-for="tile in moreTiles"
                        :key="tile.to"
                        class="group flex items-center rounded-md text-xs text-content transition-colors hover:bg-content/5"
                    >
                        <RouterLink :to="tile.to" class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left" @click="dismissMore">
                            <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                                <RailIcon :area="tile.id" :fallback="tile.icon" :label="tile.label" class="text-base text-muted" />
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
                                ui.iconButton(`mr-1 h-5 w-5 rounded text-subtle transition`),
                                `opacity-0 pointer-coarse:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100`,
                            ]"
                            :aria-label="`Keep ${tile.label} on the rail`"
                            v-tooltip.top="`Keep on the rail`"
                            @click="keepOnRail(tile)"
                        >
                            <Icon name="pin" class="text-xs" />
                        </button>
                    </div>
                </div>
            </AnchoredOverlay>

            <span class="my-1 icon-rail-divider h-px bg-line"></span>

            <!-- Present only while a tunnel is up: while connected, all traffic leaves through someone else's network. -->
            <RouterLink
                v-if="connectedVpns.length > 0"
                to="/capabilities/vpn"
                class="icon-rail-tile flex items-center justify-center rounded-lg text-success transition-colors hover:bg-overlay"
                :aria-label="vpnLabel"
                v-tooltip.right="vpnLabel"
            >
                <RailIcon area="vpn" class="text-[1.375rem]" />
            </RouterLink>

            <!-- Present only while a port is forwarded, since the sandbox is then answering the public internet. -->
            <RouterLink
                v-if="forwardedPorts.length > 0"
                to="/sandbox/ports"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-warning transition-colors hover:bg-overlay"
                :aria-label="forwardedLabel"
                v-tooltip.right="forwardedLabel"
            >
                <RailIcon area="ports" class="text-[1.375rem]" />
                <span
                    v-if="forwardedPorts.length > 1"
                    class="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-warning/15 px-1 text-center text-[0.6rem] font-semibold leading-4 text-warning"
                    >{{ forwardedPorts.length }}</span
                >
            </RouterLink>

            <!--
                Live-runtime surfaces, like the terminal, so they sit in this cluster rather than the nav tiles.
                Same AreaTile markup as those tiles, badged by what's still running (browserTile/subagentTile).
            -->
            <RouterLink
                v-for="tile in runtimeTiles"
                :key="tile.to"
                :to="tile.to"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                :aria-label="tileLabel(tile)"
                v-tooltip.right="tileLabel(tile)"
            >
                <RailIcon :area="tile.id" :fallback="tile.icon" :label="tile.label" class="text-[1.375rem]" />
                <!-- No tooltip on the badge, for the same reason as the navigation tiles above. -->
                <span
                    v-if="tile.badge"
                    class="absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
                    :class="badgeClass(tile.badge)"
                >
                    <Icon v-if="tile.badge.mark !== undefined" :name="tile.badge.mark as IconName" />
                    <template v-else>{{ badgeText(tile.badge) }}</template>
                </span>
            </RouterLink>

            <!--
                Toggles the one global terminal panel, badged with live sessions (background jobs excluded, they
                never idle). Inert while unreachable — a PTY has no offline form — and absent below maintainer tier.
            -->
            <button
                v-if="canShip"
                type="button"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'bg-primary-600/15 text-link': terminal.open.value }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                :aria-label="terminalLabel"
                v-tooltip.right="terminalLabel"
                @click="terminal.toggle()"
            >
                <RailIcon area="terminal" class="text-[1.375rem]" />
                <span
                    v-if="terminalActivity.count.value > 0"
                    class="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary-600/15 px-1 text-center text-[0.6rem] font-semibold leading-4 text-link"
                    >{{ terminalActivity.count.value > 99 ? "99+" : terminalActivity.count.value }}</span
                >
            </button>

            <!--
                Every "add" here writes to the sandbox's deploy.config.ts or clones into /work, never platform
                storage. Lights in the rail's one accent when active, like a nav tile — never a second color.
            -->
            <RouterLink
                to="/capabilities"
                :class="[
                    ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`),
                    { 'border-link bg-primary-600/15 text-link': isNavActive('/capabilities') },
                ]"
                aria-label="Add a capability"
                v-tooltip.right="'Add a capability'"
            >
                <RailIcon area="capabilities" class="text-[1.375rem]" />
            </RouterLink>

            <!-- The account control: avatar opening a popover with account identity and actions. -->
            <AccountPanel />
        </nav>

        <!--
            A slot, not the panel: the panel mounts above the router and teleports in here (dockSlots.ts), so
            one live instance serves the column, the floating window, and routes this shell doesn't cover.
        -->
        <div ref="chatDock" class="contents"></div>

        <main class="relative flex min-w-0 flex-col overflow-hidden" style="grid-area: workspace">
            <SandboxGate>
                <div class="min-h-0 flex-1 overflow-auto scrollbar-thin">
                    <RouterView />
                </div>
                <!-- Inside the gate: a docked terminal stays mounted through a stall, its own recovery keeping scrollback. -->
                <div ref="terminalDock" class="contents"></div>
            </SandboxGate>
        </main>

        <!-- Portals to body, so it overlays the whole shell regardless of where it sits in the grid. -->
        <QuickOpen />

        <!-- A tile's right-click menu (tileMenuItems): the chat's homes, or the pin. -->
        <ContextMenu ref="tileMenu" :model="tileMenuItems" :min-width="15" />
    </div>
</template>

<style scoped>
.shell {
    /* Floor is 0, not the stored width, which was clamped at drag time and could push past a shrunk window. */
    grid-template-columns: var(--icon-rail-width) minmax(0, 1fr) minmax(0, var(--chat-width, 22rem));
    /* One explicit row, so a stray element landing in an implicit row can't starve 1fr to zero height. */
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: "rail workspace chat";
}

.icon-rail {
    gap: var(--icon-rail-gap);
    padding-block: var(--icon-rail-padding);
    /* An inset shadow, not a background: layers over a skin's own background-image without a specificity fight. */
    box-shadow: inset 0 0 0 100vmax color-mix(in oklab, var(--color-brand-950) 8%, transparent);
}

/* flex-shrink: 0 everywhere: with `height` (not min-height) tiles would otherwise compress instead of scrolling. */
.icon-rail > *,
.icon-rail-tile,
.icon-rail-band,
.icon-rail-divider {
    flex-shrink: 0;
}

/* One gap unit for a band seam, matching the old hairline's rhythm; scales with the rail via `rail()`. */
.icon-rail-band {
    height: var(--icon-rail-gap);
}

/* The one unbounded run (one tile per extension), so it's the one that scrolls; everything else stays anchored. */
.icon-rail-nav {
    flex-shrink: 1;
    min-height: 0;
    gap: var(--icon-rail-gap);
    /* Scrollbar hidden (.scrollbar-none): in a 44px column it would eat a quarter of it. */
}

.icon-rail-tile {
    width: var(--icon-rail-tile-size);
    height: var(--icon-rail-tile-size);
}

.icon-rail-divider {
    width: var(--icon-rail-divider-width);
}
</style>
