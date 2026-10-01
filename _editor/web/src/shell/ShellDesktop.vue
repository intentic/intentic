<script setup lang="ts">
import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
import { AnchoredOverlay, browserOwnsClick, ui, ContextMenu, type IconName, type Tip, type TipTone, type TooltipValue } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { isNavigationFailure, NavigationFailureType, RouterView, useRoute, useRouter } from "vue-router";
import { useWallpaperedRoute } from "../skins/useWallpaper";
import { agentsBadge, agentsScopeNote } from "../features/agents/board/agentsTile";
import { useBrowsersQuery } from "../features/browsers/browsersQuery";
import { useCapabilities } from "../features/capabilities/connect/useCapabilities";
import { useRole } from "../features/sandbox/secrets/useRole";
import { useTerminalPanel } from "../features/terminal/useTerminalPanel";
import { useTerminalActivity } from "../features/terminal/useTerminalActivity";
import { GO_TO } from "./commands/categories";
import { useNavigationCommands } from "./commands/useNavigationCommands";
import { commandShortcut, registerCommand } from "./commands/useCommands";
import {
    type ActiveExtension,
    activationBadge,
    sectionReachable,
    detectActivations,
    extensionPath,
    railBands,
    railRank,
    onRail,
    railPolicy,
    onRailOnlyByVisit,
    DEVICES_VIEW_ID,
} from "../core-views/registry";
import ViewBadgeChip from "../core-views/ViewBadgeChip.vue";
import { useVocabulary } from "../core-views/vocabulary";
import { useAudience } from "../app/useAudience";
import { chatInSidePanel, chatOnRail, lastSectionPath, toggleChatFloating, toggleChatHome } from "../features/chat/panel/chatPanelLayout";
import { useChatFloating } from "../features/chat/panel/chatFloating";
import { useShellCommands } from "./commands/useShellCommands";
import { useKeybindings } from "./commands/useKeybindings";
import { useLayout } from "./window/useLayout";
import { uiLength } from "./window/uiScale";
import { useIconRailSize } from "./rail/useIconRailSize";
import { railFrame } from "./rail/railFrame";
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
import { useLiveLinks } from "../features/sandbox/devices/useLiveLinks";
import { useSyncHealth } from "../features/sandbox/devices/useDevices";
import { devicesWorking } from "../features/sandbox/devices/runners/deviceWork";
import { sandboxSectionPath } from "../features/sandbox/sandboxNav";
import { extensionsLoaded } from "../extension-host/loader";
import AccountPanel from "./AccountPanel.vue";
import ChatQuickBar from "../features/chat/panel/ChatQuickBar.vue";
import { terminalSlot } from "./window/panelSlots";
import SidePanel from "./side/SidePanel.vue";
import { registerCoreSideViews } from "./side/coreSideViews";
import { setSplit, sideDocked } from "./side/sideTabs";
import { besideChat, besideFills } from "./side/sideLayout";
import { shownSideTabs } from "./side/sideViews";
import { type RailTile, useRailMemory } from "./rail/railMemory";
import { useRailPins } from "./rail/railPins";
import RailIcon from "./rail/RailIcon.vue";
import TileMark from "./rail/TileMark.vue";
import { RUNNING_MARK_CLASS } from "../core-views/viewBadge";
import PresenceAvatars from "./presence/PresenceAvatars.vue";
import QuickOpen from "./commands/QuickOpen.vue";
import SandboxGate from "../features/sandbox/gates/SandboxGate.vue";
import SandboxSwitcher from "../features/sandbox/gates/SandboxSwitcher.vue";
import { useInbox } from "../features/needs/inbox/useInbox";
import { useT } from "@intentic/ui/i18n";

// A rail element; the identity half (id, route, label, icon) is RailTile, shared with the rail's memory.
// - id: the tile's own name or contributing extension's id — what RAIL_GROUPS ranks and groups by.
// - icon: undefined for a repository tile, which renders initials instead.
const t = useT();

interface SectionTile extends RailTile {
    // Same shape core sections and extensions both fill, so the rail renders one badge element.
    readonly badge?: ViewBadge;
    // A standing fact about the tile (not news); today only the Agents tile's cross-sandbox scope uses it.
    readonly note?: { readonly icon: IconName; readonly text: string };
    // Set on a held tile for a tile not yet loaded: dim, inert, never badged (railMemory.ts).
    readonly ghost?: boolean;
}

// One label per tile — name, badge tooltip, what's running, then note (what is owed, then what is moving,
// then standing facts). A badge has no tooltip of its own: nesting one inside the tile's would open two
// overlapping boxes on hover, and the turning mark can't carry one either, being 10px of glyph.
const tileParts = (tile: SectionTile): string[] =>
    [tile.badge?.tooltip, tile.badge?.running, tile.note?.text].flatMap((part) => (part === undefined || part === `` ? [] : [part]));
const tileLabel = (tile: SectionTile): string => [tile.label, ...tileParts(tile)].join(` · `);
// The hover: the name alone, or the name as a card's headline over what the tile is carrying. A warning or danger badge
// lends the headline its dot, since that tone marks a standing state rather than a count.
const badgeTone = (tone: ViewBadge[`tone`]): TipTone | undefined => (tone === `warning` ? `warn` : tone === `danger` ? `danger` : undefined);
const tileTip = (tile: SectionTile, extra?: string): TooltipValue => {
    const parts = [...tileParts(tile), ...(extra === undefined ? [] : [extra])];
    if (parts.length === 0) {
        return tile.label;
    }
    const tone = badgeTone(tile.badge?.tone);
    return { title: tile.label, tone, note: parts.join(` · `) };
};

// Desktop chrome of the post-login shell: a square-tile rail, a workspace outlet, and the side panel (the chat and what
// was opened beside), laid out as a three-column grid (the side panel's width via --side-width, set by its drag handle).
// Shared lifecycle (liveness, presence, plan) lives in WorkspaceShell, which picks this or ShellMobile.

const { panels, settled: panelsSettled } = usePanels();
const { capabilities, settled: capabilitiesSettled } = useCapabilities();
// Always-on, loosely polled, so the tile appears mid-turn; the view polls tighter once it's open.
const { sessions: browsers } = useBrowsersQuery();
const { reachable } = useSandbox();
// Ship-tier only: a PTY is the whole sandbox, and the daemon refuses the socket below maintainer anyway. Devices, the
// same: the hub withholds the section below maintainer, where the daemon refuses what it is for.
const { canShip, isGuest } = useRole();
// Uncommitted changes badge the Workspace tile, so the count is visible from any section.
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
// The audience's words for the two core tiles that have maker names (Files, See it); Chat and Agents keep theirs.
const words = useVocabulary();
const { maker } = useAudience();

// Shown only while a tunnel is connected; an always-present badge would say nothing.
const { links: vpnLinks } = useLiveLinks(`vpn`);
const connectedVpns = computed(() => vpnLinks.value.filter((link) => link.state === `connected`));
const vpnNames = computed(() => connectedVpns.value.map((link) => link.id).join(`, `));
const vpnLabel = computed(() => `${t(`shell.shellDesktop.vpnConnected`)}: ${vpnNames.value}`);
const vpnTip = computed(
    (): Tip => ({
        title: t(`shell.shellDesktop.vpnConnected`),
        tone: `ok`,
        rows: [{ label: t(`shell.shellDesktop.tunnels`, {}, connectedVpns.value.length), value: vpnNames.value }],
    }),
);

// Same idea as the VPN badge: visible everywhere, not only on the Ports tab.
const { forwarded: forwardedPorts } = usePorts();
const forwardedList = computed(() => forwardedPorts.value.map((entry) => entry.port).join(`, `));
const forwardedLabel = computed(() => `${t(`shell.shellDesktop.publiclyReachable`)}: ${forwardedList.value}`);
const forwardedTip = computed(
    (): Tip => ({
        title: t(`shell.shellDesktop.publiclyReachable`),
        tone: `warn`,
        rows: [{ label: t(`shell.shellDesktop.ports`, {}, forwardedPorts.value.length), value: forwardedList.value }],
    }),
);
// One port needs no number — the tile itself is the news. Two or more do, through the same chip as every
// other tile rather than a hand-rolled span, so the cap, the tone and the arrival are decided in one place.
const portsBadge = computed<ViewBadge | undefined>(() =>
    forwardedPorts.value.length > 1 ? { count: forwardedPorts.value.length, tone: `warning` } : undefined,
);

// Prefix match, not active-class: a splat/optional param (workspace/:path) drops it once one is set.
const isNavActive = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);

// Mirrors the panel's own priority: uncommitted count (size matters) before an outgoing push (a glyph,
// since size doesn't); a push in flight comes first, being this tile's only sign of it.
const workspaceBadge = computed<ViewBadge | undefined>(() => {
    // Orthogonal to whatever the badge SAYS: a running mark is drawn beside the tile, so a land rides whichever badge
    // wins below and stands alone when none does — the count is still 0 until the patch is in the tree.
    const landing: Pick<ViewBadge, `running`> = changes.landing.value === undefined ? {} : { running: changes.landing.value };
    const push = pushBadge(pushFlow.running.value, pushFlow.question.value, pushFlow.held.value);
    if (push !== undefined) {
        return { ...push, ...landing };
    }
    if (changes.count.value > 0) {
        return {
            count: changes.count.value,
            tooltip: `${changes.count.value} ${changes.count.value === 1 ? words.value.pendingChange : words.value.pendingChanges}`,
            ...landing,
        };
    }
    const work = changes.outgoing.value;
    if (work === undefined) {
        return changes.landing.value === undefined ? undefined : landing;
    }
    return { mark: outgoingMark(work), tooltip: outgoingSummary(work), ...landing };
});

// On the rail only while chat is docked and not floated, except briefly after popping out from /chat itself.
const chatTileSeated = computed(() => chatOnRail.value && (!chatFloats.value || route.name === `chat`));

/* Preview closes the Work band by showing the running result. */
const { files: publicFiles } = usePublicOutbox();
const previewTile = computed<SectionTile | undefined>(() => {
    if (!previewEvidence(panels.value, forwardedPorts.value, publicFiles.value)) {
        return undefined;
    }
    const healthy = previewHealthyCount(panels.value, forwardedPorts.value, publicFiles.value);
    return {
        id: `preview`,
        to: `/preview`,
        label: words.value.preview,
        icon: `eye`,
        ...(healthy > 0 ? { badge: { count: healthy, tone: `neutral` as const, tooltip: t(`shell.shellDesktop.running`, { healthy }) } } : {}),
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

// THE MACHINES THIS SANDBOX REACHES, tiled the way This computer is in a local window (the same glyph and the same
// corners): a place to go, the count the hub's Devices row carries, and the turning mark while one of them is being
// worked on. That mark is the reason it is a tile at all: an agent update outlives the page that pressed it by a minute
// or more (devices/runners/deviceWork.ts), and the switcher chip turns only for a restart of this sandbox. The count is
// the hub row's own (SandboxHub.vue): ports another of your sandboxes took, the one held port with a remedy there.
const { heldPorts } = useSyncHealth();
const devicesBadge = (held: number, running: string | undefined): ViewBadge | undefined => {
    if (held === 0) {
        return running === undefined ? undefined : { running };
    }
    const count: ViewBadge = { count: held, tone: `info`, tooltip: t(`shell.shellDesktop.portsTaken`, { count: held }, held) };
    return running === undefined ? count : { ...count, running };
};
const devicesTile = computed<SectionTile>(() => {
    const tile: SectionTile = { id: DEVICES_VIEW_ID, to: sandboxSectionPath(`devices`), label: t(`sandbox.words.devicesSection`), icon: `desktop` };
    const badge = devicesBadge(heldPorts.value.length, devicesWorking());
    return badge === undefined ? tile : { ...tile, badge };
});

// The always-present tiles plus evidence-driven Preview; extension tiles are added separately below,
// one per activation. The rest of sandbox management lives behind the switcher chip, not a rail tile.
const fixedTiles = computed<readonly SectionTile[]>(() => [
    // Below the Projects tile in the Work band; unbadged, since the Agents tile below carries the debt (see chatTileSeated).
    ...(chatTileSeated.value
        ? [
              {
                  id: `chat`,
                  to: `/chat`,
                  label: t(`shared.chat`),
                  icon: `comments` as IconName,
              },
          ]
        : []),
    {
        id: `agents`,
        to: `/agents`,
        label: t(`shared.agents`),
        // RailIcon draws by section identity; these generic names remain the fallback vocabulary.
        icon: `robot`,
        // Both come from agentsTile.ts, shared with the phone tab bar; the note names the scope when it's wide.
        ...(agentsBadge.value === undefined ? {} : { badge: agentsBadge.value }),
        ...(agentsScopeNote.value === undefined ? {} : { note: { icon: `boxes` as IconName, text: agentsScopeNote.value } }),
    },
    {
        id: `workspace`,
        to: `/workspace`,
        label: words.value.workspace,
        icon: `file-tree`,
        ...(workspaceBadge.value === undefined ? {} : { badge: workspaceBadge.value }),
    },
    ...(previewTile.value === undefined ? [] : [previewTile.value]),
    ...(canShip.value ? [devicesTile.value] : []),
]);
/* The Browsers tile stays visible while the daemon lists an open browser. */
const browserTile = computed<SectionTile | undefined>(() => {
    if (browsers.value.length === 0) {
        return undefined;
    }
    const live = browsers.value.filter((session) => session.running).length;
    const helping = browsers.value.filter((session) => session.help !== undefined).length;
    return {
        id: `browsers`,
        to: `/browsers`,
        label: t(`shared.browsers`),
        icon: `desktop`,
        // Neutral: an open browser is inventory, not a debt; warning only when the agent is waiting on the user.
        ...(helping > 0
            ? { badge: { count: helping, tone: `warning` as const, tooltip: t(`shell.shellDesktop.agentNeedsHelp`) } }
            : live > 0
              ? { badge: { count: live, tone: `neutral` as const, tooltip: t(`shell.shellDesktop.open`, { live }) } }
              : {}),
    };
});
// Everything waiting on a person (docs/architecture/needs.md, the Needs you inbox): what agents asked for, turns parked
// on an answer, held wakes, extensions and every view's asks, in one count. On the rail only while something is.
const { badge: inboxBadge } = useInbox();
const needsTile = computed<SectionTile | undefined>(() =>
    inboxBadge.value === undefined
        ? undefined
        : {
              id: `needs`,
              to: `/needs`,
              label: t(`needs.inbox.title`),
              icon: `exclamation-circle`,
              badge: inboxBadge.value,
          },
);
// Same SectionTile shape as the nav tiles, so badges render through one path instead of per hand-rolled link.
const runtimeTiles = computed<readonly SectionTile[]>(() =>
    [needsTile.value, browserTile.value].filter((tile) => tile !== undefined).filter((tile) => sectionReachable(tile.to)),
);
// RailIcon selects bespoke glyphs by view id and validates extension fallbacks before drawing them.
const extensionTile = (active: ActiveExtension): SectionTile => {
    const { extension, activation } = active;
    const badge = activationBadge(active);
    return {
        id: extension.id,
        to: extensionPath(extension, activation),
        label: activation.title,
        ...(activation.icon === undefined ? {} : { icon: activation.icon as IconName }),
        ...(activation.monogram === undefined ? {} : { monogram: activation.monogram }),
        ...(badge === undefined ? {} : { badge }),
    };
};
// Every nav tile, on the rail or not, in one run ranked by RAIL_GROUPS (core sections, then one tile per
// extension activation); the on the rail and More lists both come from this run, so a section is never in both or neither.
const tiles = computed<readonly SectionTile[]>(() =>
    [
        ...fixedTiles.value,
        ...detectActivations(panels.value, capabilities.value)
            // Only rail-surface extensions get a tile; per-repo panels open from the Workspace tree instead.
            .filter(({ extension }) => extension.surface === `rail`)
            .map(extensionTile),
    ]
        // Before the rail and before More: a section this reader cannot open belongs in neither list.
        .filter((tile) => sectionReachable(tile.to))
        .toSorted((left, right) => railRank(left.id) - railRank(right.id)),
);
// True once extensions, panels, and capabilities have all loaded; before that a missing tile is only late.
const railSettled = computed(() => extensionsLoaded.value && panelsSettled.value && capabilitiesSettled.value);

// onRail (registry.ts) holds the rule; this only supplies the live facts: pinned and active.
const pins = useRailPins();
const onRailTiles = computed<readonly SectionTile[]>(() =>
    tiles.value.filter((tile) => onRail(tile, { pinned: pins.pinned.value.has(tile.to), active: isNavActive(tile.to) })),
);
const moreTiles = computed<readonly SectionTile[]>(() =>
    tiles.value.filter((tile) => !onRailTiles.value.includes(tile)).toSorted((left, right) => left.label.localeCompare(right.label)),
);

// tileTip, plus one clause when a tile is on the rail only by the visit: says so once, while it can still
// be pinned. Not used by the runtime cluster below — those tiles can't be pinned at all.
const visitingNote = (tile: SectionTile): string | undefined =>
    onRailOnlyByVisit(tile, { pinned: pins.isPinned(tile.to), active: isNavActive(tile.to) }) ? t(`shell.shellDesktop.rightClickKeep`) : undefined;
const railTileLabel = (tile: SectionTile): string => [tileLabel(tile), visitingNote(tile)].filter((part) => part !== undefined).join(` · `);
const railTileTip = (tile: SectionTile): TooltipValue => tileTip(tile, visitingNote(tile));

// Only the permanent tiles and this reader's pins — the tiles that will still be there tomorrow.
const stableTiles = computed<readonly SectionTile[]>(() =>
    tiles.value.filter((tile) => railPolicy(tile.id) === `always` || pins.pinned.value.has(tile.to)),
);
// Tiles the rail had last time and hasn't refilled yet; empty once complete or on a first visit.
const heldTiles = useRailMemory(stableTiles, railSettled);
// On-rail tiles plus held tiles, sorted by the same table, so each lands where it will take its place.
const railTiles = computed<readonly SectionTile[]>(() =>
    [...onRailTiles.value, ...heldTiles.value].toSorted((left, right) => railRank(left.id) - railRank(right.id)),
);
// Held tiles are included so band hairlines don't shift position as the run fills in.
const tileBands = computed(() => railBands(railTiles.value, (tile) => tile.id));

// Alt+Up/Down walks the on the rail nav tiles only (the runtime cluster's length changes under a running
// turn); wraps, and from a route no tile owns enters at the end the press is heading toward.
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
        registerCommand({
            owner: `builtin`,
            command: `view.previousSection`,
            title: t(`shell.shellDesktop.previousRailSection`),
            category: GO_TO,
            icon: `chevron-up`,
            keybinding: `Alt+ArrowUp`,
            handler: () => cycleSection(-1),
        }),
        registerCommand({
            owner: `builtin`,
            command: `view.nextSection`,
            title: t(`shell.shellDesktop.nextRailSection`),
            category: GO_TO,
            icon: `chevron-down`,
            keybinding: `Alt+ArrowDown`,
            handler: () => cycleSection(1),
        }),
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

// Tracks the last non-chat path, not browser history, which may start on /chat itself (a reload, a link).
watch(
    () => route.path,
    (path) => {
        if (!path.startsWith(`/chat`)) {
            lastSectionPath.value = path;
        }
    },
    { immediate: true },
);

// Position the menu beside the rail tile using a synthetic event.
const showBesideRail = (menu: { show: (event: Event) => void } | undefined, event: MouseEvent): void => {
    const tile = event.currentTarget as HTMLElement | null;
    const rail = (tile?.closest(`nav`) ?? tile)?.getBoundingClientRect();
    const top = tile?.getBoundingClientRect().top;
    menu?.show(rail === undefined || top === undefined ? event : new MouseEvent(`click`, { clientX: rail.right, clientY: top }));
};

// Two menus: the chat tile offers where it goes next (dock/float, same toggles as elsewhere); every
// other on the rail tile offers the pin — permanent tiles get no row, since they're already always on the rail.
const tileMenu = ref<{ show: (event: Event) => void }>();
const menuTile = ref<RailTile>();
const tileMenuItems = computed<MenuItem[]>(() => {
    const tile = menuTile.value;
    if (tile === undefined) {
        return [];
    }
    if (tile.id === `chat`) {
        return [
            {
                label: t(`shell.shellDesktop.dockChatBackTo`),
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
            label: t(`shell.shellDesktop.keepOnRail2`),
            // States what happens either way, since this is the one place the tile rule is explained.
            hint: pins.isPinned(tile.to) ? `Always on the rail, badge or not` : `Otherwise it shows only when it needs you`,
            checked: pins.isPinned(tile.to),
            command: (): void => pins.toggle(tile.to),
        },
    ];
});
const onTileContextMenu = (tile: RailTile, event: MouseEvent): void => {
    if (tile.id !== `chat` && railPolicy(tile.id) === `always`) {
        return; // A permanent tile has nothing to offer here; keep the browser's own menu.
    }
    event.preventDefault();
    menuTile.value = tile;
    showBesideRail(tileMenu.value, event);
};

// Every offRail section, as real links (so click behaviors work), sorted alphabetically rather than by
// rail rank; each row can pin the section (railPins.ts). Never badges — anything with something to say is already on the rail.
const moreTrigger = ref<HTMLButtonElement | null>(null);
const moreOpen = ref(false);
// The section's own area, which the parked chat's bar floats over and is dismissed by a press on.
const page = ref<HTMLElement | null>(null);
// The count is the whole point of hovering; phrased like every other tile's label. A `computed`, so it is rebuilt
// when the language changes rather than holding the words it was born with.
const moreLabel = computed(() =>
    moreTiles.value.length === 0
        ? t(`shell.shellDesktop.moreSections`)
        : t(`shell.shellDesktop.moreSectionsOffRail`, { count: moreTiles.value.length }, moreTiles.value.length),
);
const moreTip = computed(
    (): Tip => ({
        title: t(`shell.shellDesktop.moreSections`),
        rows: moreTiles.value.length === 0 ? [] : [{ label: t(`shell.shellDesktop.offRail`), value: moreTiles.value.length }],
    }),
);
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

// The side panel (shell/side) takes its column while it holds anything: the chat whose home is the side, or what was
// opened beside the section. Empty, the column is 0 wide. Holding both, what was opened fills the middle, the panel
// spanning the section's cell too (sideLayout.ts), or, split, the column is wide enough for the two side by side.
const sideShown = computed(() => chatInSidePanel.value || shownSideTabs.value.length > 0);
const sideWidth = computed(() =>
    besideChat.value && !besideFills.value ? layout.chatWidth.value + layout.besideWidth.value : layout.chatWidth.value,
);
const gridStyle = computed(() => ({
    "--side-width": sideShown.value ? uiLength(sideWidth.value) : `0px`,
    // The rail's own measures, shared with a desktop window on a local folder (railFrame.ts, iconRail.css).
    ...railFrame(iconRailSize.value),
}));

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
const stopSectionVisits = router.afterEach((to, from, failure) => {
    if (failure === undefined ? to.path !== from.path : isNavigationFailure(failure, NavigationFailureType.duplicated)) {
        showSection();
    }
});
onUnmounted(stopSectionVisits);
watch(
    () => terminal.open.value,
    (open) => open && showSection(),
);
// The only affordance for the panel now; the Workspace view's own toggle is gone, since terminals are
// sandbox-global. Doubles as an indicator: the badge counts live sessions, the tooltip names them.
const terminalActivity = useTerminalActivity();
const terminalLabel = computed(() => {
    const chord = commandShortcut(`terminal.toggle`);
    const what = [t(`shared.terminal`), terminalActivity.summary.value].filter((part) => part !== undefined).join(`, `);
    return chord === undefined ? what : `${what} (${chord})`;
});
const terminalTip = computed((): Tip => ({
    title: t(`shared.terminal`),
    keys: commandShortcut(`terminal.toggle`),
    rows: [{ label: t(`shared.running`), value: terminalActivity.summary.value ?? `` }],
}));
// Live sessions, through the shared chip like the ports tile above; `info` is the resting tone, set here
// rather than left to default so the two runtime badges state their tone side by side.
const terminalBadge = computed<ViewBadge | undefined>(() =>
    terminalActivity.count.value > 0 ? { count: terminalActivity.count.value, tone: `info` } : undefined,
);
// Registers the shell's built-in palette commands on mount, each with its own keybinding.
useShellCommands();
// One destination per place the shell has: every rail section on the rail or not, every sandbox and settings section.
useNavigationCommands();
// The single global-shortcut dispatcher: matches any registered command's keybinding to the keystroke.
useKeybindings();
// The extension pages a wallpaper shows behind; painted on the scroller so the picture stays put as the page scrolls.
const wallpapered = useWallpaperedRoute();
</script>

<template>
    <div class="shell grid h-screen overflow-hidden bg-canvas text-content" :style="gridStyle">
        <nav class="icon-rail flex flex-col items-center border-r border-line bg-card" style="grid-area: rail">
            <!-- Top of the rail: switch between sandboxes, add one, or manage access. -->
            <SandboxSwitcher />
            <!-- Other members connected right now, live from the daemon's /events roster. -->
            <PresenceAvatars :members="presenceOthers" direction="column" :size="28" />
            <!-- `my-1`, as on the other hairline: with `mb-1` alone this one sat off-centre in its own air. -->
            <span class="my-1 icon-rail-divider h-px bg-line"></span>

            <!-- Bands (Work/Judge/Know) are separated by whitespace, not lines: hairlines mark only the two real boundaries — identity, work sections, live runtime. -->
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
                            class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                            :class="{ 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                            :aria-label="railTileLabel(tile)"
                            v-tooltip.right="railTileTip(tile)"
                            @contextmenu="onTileContextMenu(tile, $event)"
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
                        </RouterLink>
                    </template>
                </template>
            </div>

            <!-- Every offRail section; kept outside the scrolling run so it's never scrolled out of sight. -->
            <!-- A door to sections, not an "add one": the same tile as the nav run above it, so the dashed rim is left to the
                 one control on this rail that really does add something. -->
            <!-- Empty for an owner means "everything is on the rail", which is worth a tile and a sentence. Empty for a guest
                 means there is nothing to put there and never will be, so the door itself goes. -->
            <button
                v-if="!isGuest"
                ref="moreTrigger"
                type="button"
                class="icon-rail-tile flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'bg-primary-600/15 text-link': moreOpen }"
                aria-haspopup="menu"
                :aria-expanded="moreOpen"
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
                    <template v-if="moreTiles.length === 0">
                        <p class="px-2 pt-1.5 text-xs text-subtle">{{ t(`shell.shellDesktop.everySectionOnRail`) }}</p>
                        <p class="px-2 pb-1.5 text-2xs text-subtle">{{ t(`shell.shellDesktop.howToUnpin`) }}</p>
                    </template>
                    <!-- Two controls per row — go there, and pin it (keepOnRail) — as siblings, not nested. -->
                    <div
                        v-for="tile in moreTiles"
                        :key="tile.to"
                        class="group flex items-center rounded-md text-xs text-content transition-colors hover:bg-content/5"
                    >
                        <RouterLink :to="tile.to" class="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left" @click="dismissMore">
                            <span class="flex h-5 w-5 shrink-0 items-center justify-center">
                                <RailIcon :section="tile.id" :fallback="tile.icon" :label="tile.label" class="text-base text-muted" />
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
                            :aria-label="t(`shell.shellDesktop.keepOnRail`, { label: tile.label })"
                            v-tooltip.top="t(`shell.shellDesktop.pin`)"
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
                v-tooltip.right="vpnTip"
            >
                <RailIcon section="vpn" class="icon-rail-glyph" />
            </RouterLink>

            <!-- Present only while a port is forwarded, since the sandbox is then answering the public internet. -->
            <RouterLink
                v-if="forwardedPorts.length > 0"
                to="/sandbox/ports"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-warning transition-colors hover:bg-overlay"
                :aria-label="forwardedLabel"
                v-tooltip.right="forwardedTip"
            >
                <RailIcon section="ports" class="icon-rail-glyph" />
                <ViewBadgeChip :badge="portsBadge" class="icon-rail-mark absolute right-0.5 top-0.5" />
            </RouterLink>

            <!-- Live-runtime surfaces, like the terminal, so they sit in this cluster rather than the nav tiles. -->
            <RouterLink
                v-for="tile in runtimeTiles"
                :key="tile.to"
                :to="tile.to"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                :aria-label="tileLabel(tile)"
                v-tooltip.right="tileTip(tile)"
            >
                <RailIcon :section="tile.id" :fallback="tile.icon" :label="tile.label" :monogram="tile.monogram" class="icon-rail-glyph" />
                <!-- No tooltip on the badge, for the same reason as the navigation tiles above. -->
                <ViewBadgeChip :badge="tile.badge" class="icon-rail-mark absolute right-0.5 top-0.5" />
                <!-- Same running mark as a navigation tile, so live work reads identically in both clusters. -->
                <TileMark
                    v-if="tile.badge?.running !== undefined"
                    name="spinner"
                    spin
                    :class="[RUNNING_MARK_CLASS, `icon-rail-mark absolute bottom-0.5 right-0.5`]"
                />
            </RouterLink>

            <!-- Toggles the one global terminal panel, badged with live sessions (background jobs excluded, they never idle). A maker never asked for a shell. -->
            <button
                v-if="canShip && !maker"
                type="button"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'bg-primary-600/15 text-link': terminal.open.value }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                :aria-label="terminalLabel"
                v-tooltip.right="terminalTip"
                @click="terminal.toggle()"
            >
                <RailIcon section="terminal" class="icon-rail-glyph" />
                <ViewBadgeChip :badge="terminalBadge" class="icon-rail-mark absolute right-0.5 top-0.5" />
            </button>

            <!-- Every "add" here writes to the sandbox's deploy.config.ts or clones into /work, never platform storage. -->
            <!-- A guest connects nothing: what this box can reach is the operator's decision, and the page says so at
                 the maintainer tier. -->
            <RouterLink
                v-if="!isGuest"
                to="/capabilities"
                :class="[
                    ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`),
                    { 'border-link bg-primary-600/15 text-link': isNavActive('/capabilities') },
                ]"
                :aria-label="t(`shell.words.addCapability`)"
                v-tooltip.right="t(`shell.words.addCapability`)"
            >
                <RailIcon section="capabilities" class="icon-rail-glyph" />
            </RouterLink>

            <!-- The account control: avatar opening a popover with account identity and actions. -->
            <AccountPanel />
        </nav>

        <!-- The right-hand column: things opened beside the section, and the chat when its home is the side. -->
        <SidePanel v-if="sideShown" />

        <!-- Under what was opened while it fills the middle: hidden and inert, but mounted at its own size, so the section
             comes back as it was left, scrolled where it was. -->
        <main
            ref="page"
            class="relative flex min-w-0 flex-col overflow-hidden"
            :class="{ invisible: besideFills }"
            :inert="besideFills ? true : undefined"
            style="grid-area: workspace"
        >
            <SandboxGate>
                <div class="min-h-0 flex-1 overflow-auto" :class="{ 'wallpaper-surface': wallpapered }">
                    <RouterView />
                </div>
                <!-- Inside the gate: a docked terminal stays mounted through a stall, its own recovery keeping scrollback. -->
                <div ref="terminalSlot" class="contents"></div>
            </SandboxGate>
        </main>

        <!-- The parked chat's composer, floating in the section's own cell: growing it must not reflow the page the reader
             opened it to talk about. Outside the gate, like the chat column: a stalled sandbox is a thing to ask about. -->
        <ChatQuickBar :page="page ?? undefined" />

        <!-- Portals to body, so it overlays the whole shell regardless of where it sits in the grid. -->
        <QuickOpen />

        <!-- A tile's right-click menu (tileMenuItems): the chat's homes, or the pin. -->
        <ContextMenu ref="tileMenu" :model="tileMenuItems" :min-width="15" />
    </div>
</template>

<style scoped>
.shell {
    /* Floor is 0, not the stored width, which was clamped at drag time and could push past a shrunk window. */
    grid-template-columns: var(--icon-rail-width) minmax(0, 1fr) minmax(0, var(--side-width, 22rem));
    /* One explicit row, so a stray element landing in an implicit row can't starve 1fr to zero height. */
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: "rail workspace side";
}

/* The rail's own rules (tiles, glyphs, marks, bands) are the shared stylesheet's, shell/rail/iconRail.css. */
</style>
