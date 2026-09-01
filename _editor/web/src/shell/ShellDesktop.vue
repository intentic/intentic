<script setup lang="ts">
import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { STARTER_APP, STARTER_REPO } from "@intentic/sandbox-contract";
// `initialsOf` is the rail tile's glyph for a repository (my-shop-api → MS), so repositories stay
// distinguishable instead of all sharing one icon: the same monogram <Avatar> and <BrandMark> fall back to.
import { AnchoredOverlay, browserOwnsClick, ui, ContextMenu, type IconName, initialsOf } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { agentsBadge, agentsScopeNote } from "../composables/agents/agentsTile";
import { useBrowsersQuery } from "../composables/browser/browsersQuery";
import { useSubagentsQuery } from "../composables/subagents/subagentsQuery";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useRole } from "../composables/sandbox/useRole";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useTerminalActivity } from "../composables/terminal/useTerminalActivity";
import { useAreaCommands } from "../composables/commands/useAreaCommands";
import { commandShortcut, registerCommand } from "../composables/commands/useCommands";
import {
    type ActiveExtension,
    activationBadge,
    detectActivations,
    extensionPath,
    railBands,
    railRank,
    railSeated,
    seatPolicy,
} from "../core-views/registry";
import { badgeClass, badgeText } from "../core-views/viewBadge";
import { chatOnRail, lastAreaPath, toggleChatFloating, toggleChatHome } from "../composables/chat/chatSurface";
import { useChatFloating } from "../composables/chat/chatFloating";
import { useShellCommands } from "../composables/commands/useShellCommands";
import { useKeybindings } from "../composables/commands/useKeybindings";
import { useLayout } from "../composables/useLayout";
import { uiLength } from "../composables/uiScale";
import { ICON_RAIL_WIDTH_REM, useIconRailSize } from "../composables/useIconRailSize";
import { presenceOthers } from "../composables/usePresence";
import { usePanels } from "../composables/extensions/usePanels";
import { appTargetId, previewEvidence, previewHealthyCount } from "../composables/preview/previewModel";
import { openPreviewOnFirstVisit } from "../composables/preview/previewSurface";
import { usePublicOutbox } from "../composables/workspace/usePublicOutbox";
import { outgoingMark, outgoingSummary } from "../composables/workspace/outgoingWork";
import { useChanges } from "../composables/workspace/useChanges";
import { pushBadge } from "../composables/workspace/pushBadge";
import { usePushFlow } from "../composables/workspace/usePushFlow";
import { usePorts } from "../composables/sandbox/usePorts";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useVpn } from "../composables/sandbox/useVpn";
import { extensionsLoaded } from "../extension-host/loader";
import AccountPanel from "./AccountPanel.vue";
import { chatDock, terminalDock } from "./dockSlots";
import { type RailSeat, useRailMemory } from "./railMemory";
import { useRailPins } from "./railPins";
import PresenceAvatars from "../presence/PresenceAvatars.vue";
import QuickOpen from "./QuickOpen.vue";
import SandboxGate from "../sandbox-gates/SandboxGate.vue";
import SandboxSwitcher from "../sandbox-gates/SandboxSwitcher.vue";

/* A rail element. The identity half (id, route, label, icon) is `RailSeat`, which is also the shape the rail's
 * memory keeps, so a remembered seat and a live tile are the same thing to everything downstream of here: one
 * sort, one banding, one template.
 *   id   : a core shell tile's own name, or the contributing extension's id. It is what RAIL_GROUPS ranks and
 *           groups by, so core tiles and extension tiles sort against ONE table (see registry.ts) instead of
 *           core tiles being pinned above and extensions ordered among themselves.
 *   to   : the route the tile links to (e.g. /workspace, /panel/app).
 *   icon : an `IconName` for the fixed areas; undefined for a repository tile, which renders initials instead. */
interface AreaTile extends RailSeat {
    // What the tile says without being opened. The same shape core areas and extensions both fill, so the rail
    // renders ONE badge element instead of a hardcoded span per route.
    readonly badge?: ViewBadge;
    /* A STANDING FACT ABOUT THE TILE'S SUBJECT, not news from it: drawn as a small glyph in the corner the badge
     * does not use, in the rail's quiet ink, and never in a tone. The badge answers "what happened", this
     * answers "what is this tile currently about", and they are separate elements because a `mark` REPLACES the
     * count (see the badge's own note) and one of the two claims would have to go.
     *
     * The Agents tile's cross-sandbox scope is the only one today, and it is what the field is for: a reader
     * standing in Workspace has no other way to know the board's count is about four machines. Kept general
     * because the shape is: any tile whose subject can widen owes the same sentence. */
    readonly note?: { readonly icon: IconName; readonly text: string };
    // Set on a seat being held for a tile that hasn't loaded yet: drawn dim and inert, never badged. See
    // railMemory.ts for why the rail draws seats it does not yet have tiles for.
    readonly ghost?: boolean;
}

// ONE label per tile, badge included. The badge used to carry a tooltip of its own, nested inside the tile's:
// and `mouseenter` fires on an element AND every ancestor it entered, so hovering the count opened both boxes,
// one over the other ("Browsers" behind "1 agent browser open"). What the badge says is a fact ABOUT the tile,
// so it belongs in the tile's own label rather than on a second anchor 16px wide. It matters more since the
// badge grew a `mark`: a glyph states only THAT something is waiting, and the sentence carrying how much is
// then the only place the amount exists.
//
// The note joins on the same terms and comes LAST: news before standing facts, because the reader hovering a
// badged tile is asking what happened, not what the tile is about. Both are glyphs a few pixels wide, and this
// sentence is where each of them is written out.
const tileLabel = (tile: AreaTile): string => [tile.label, tile.badge?.tooltip, tile.note?.text].filter((part) => part !== undefined).join(` · `);

/* The desktop chrome of the post-login shell: a square-tile rail, the shared Claude Code chat panel, and a
 * workspace outlet for the active area. Layout is a three-column CSS grid; the chat width is driven by a
 * `--chat-width` CSS variable (useLayout), which the chat panel's drag handle updates. The shared (device-
 * independent) lifecycle (liveness, presence, plan) lives in WorkspaceShell, which picks this or ShellMobile. */

const { panels, settled: panelsSettled } = usePanels();
const { capabilities, settled: capabilitiesSettled } = useCapabilities();
// The agent's browsers, on the same appear-on-content terms. Polled loosely: this is the always-on read that
// makes the tile show up mid-turn, and the view itself polls tighter once it is on screen.
const { sessions: browsers } = useBrowsersQuery();
// The agents this sandbox's agents started, on the same loose beat and for the same reason: this is the always-on
// read that makes the tile appear the moment a turn delegates; the area polls tighter once it is on screen.
const { sessions: subagents, running: runningSubagents } = useSubagentsQuery();
const { reachable } = useSandbox();
// Uncommitted workspace changes surface as a count badge on the Workspace rail tile, visible from any area.
const changes = useChanges();
// And so does a push the user started and then navigated away from: the run's only presence outside the panel.
const pushFlow = usePushFlow();
// "Agents need you" (pending plans/questions, land conflicts, unread finishes) badges the Agents tile, over
// whichever sandboxes the board is currently reading: see agentsTile.ts, which the phone's tab bar draws too.
const layout = useLayout();
const { iconRailSize } = useIconRailSize();
// Only what the LAYOUT needs: a chat in a window of its own is a collapsed column, in EVERY other window,
// because there is one chat surface and it is out there. The panel itself is mounted above the router: this
// shell just lends it the column (see the slot in the template).
const { floats: chatFloats } = useChatFloating();
const route = useRoute();
const router = useRouter();

// The connected tunnels behind the rail's VPN indicator. Shown only when non-empty: a VPN badge that is always
// present would say nothing, whereas one that appears exactly while traffic is tunnelled is the whole signal.
const { connected: connectedVpns } = useVpn();
const vpnLabel = computed(() =>
    connectedVpns.value.length === 1
        ? `VPN connected: ${connectedVpns.value[0]?.id}`
        : `${connectedVpns.value.length} VPNs connected: ${connectedVpns.value.map((link) => link.id).join(`, `)}`,
);

// The exposure indicator, on the same terms as the VPN one: a forwarded port is reachable by anyone holding
// its hostname until someone stops it, so the fact belongs on the surface that is visible from every view:
// not behind the Ports tab it is managed from. Absent while nothing is forwarded, which is the whole signal.
const { forwarded: forwardedPorts } = usePorts();
const forwardedLabel = computed(() =>
    forwardedPorts.value.length === 1
        ? `Port ${forwardedPorts.value[0]?.port} is publicly reachable`
        : `${forwardedPorts.value.length} ports are publicly reachable: ${forwardedPorts.value.map((entry) => entry.port).join(`, `)}`,
);

// A rail link is active for its route AND any sub-path, `active-class` can't do this: with a splat/optional
// param (workspace/:path, capabilities/:card) it compares params and drops the highlight the moment one is set
// (a file open on /workspace, a card open on /capabilities). Prefix match, harmless for the param-less tiles.
const isNavActive = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);

/* What the Workspace tile says, in the priority the panel behind it already uses: the commit box owns the
 * primary slot until there is nothing left to commit, and only then does it hand that slot to the sync, so the
 * tile is a miniature of it, and the two can never disagree about what the next move is.
 *
 * A COUNT, THEN A GLYPH. The count is for work whose size decides how you spend the next hour: two changed
 * files and two hundred are different afternoons. Outgoing commits are not that: three or thirty, it is one
 * click, so a number there would only be misread in the unit the count established one state earlier. The
 * glyph says which KIND of work is waiting, and the tooltip says how much.
 *
 * That the user committed it themselves is no argument for staying silent: on this workspace an AGENT usually
 * did, and the tree it left behind is clean.
 *
 * A PUSH IN FLIGHT COMES FIRST, above both counts: it is happening now, the user started it and then walked
 * away from the panel that shows it, and from out here this tile is the only thing that knows (pushBadge.ts). */
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

/* WHEN THE RAIL HOLDS A SEAT FOR THE CHAT: the tile is where the chat IS, so it stands only while the chat is
 * actually behind it. That means the rail is its home (docked to the side, the panel is already on every screen
 * and a tile would be a second door to it) AND it has not left for a window of its own: a tile leading to an
 * area that would only say "your chat is elsewhere" is a seat held for something that isn't coming.
 *
 * WITH ONE EXCEPTION, and it is the case where the plain rule reads worst: popping out FROM the chat area. The
 * user is standing on /chat, so retiring its tile in that same frame would leave the rail with nothing lit
 * while the view it belongs to is still on screen: the shell disowning where you are, as the reward for a
 * press that was only about a window. So the seat is kept for as long as that view is, and goes with it: the
 * next tile pressed is both the view change and the tile's exit.
 *
 * The way back never depended on the tile anyway: F9, the floating window's own menu row, or its ×, and a
 * docked chat lands in the area where the seat lights up again (shell/PoppablePanels.vue's one watch). */
const chatTileSeated = computed(() => chatOnRail.value && (!chatFloats.value || route.name === `chat`));

/* Preview closes the Work band: start a turn (Chat), read what it did (Agents/Workspace), LOOK at the running
 * app. Evidence-driven like every extension tile: it appears once the workspace has anything a live iframe can
 * show (a runnable repo, a monorepo's apps, a forwarded port, a served public page) and is absent on a box with
 * none, where it could only open an empty state. An `eye` among the Work band's face/bubble/tree: what this
 * tile does is look. The badge counts what is actually ANSWERING right now: neutral, because "your app is up"
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

/* THE STARTER SITE, SHOWN RATHER THAN MENTIONED. A brand-new sandbox has a one-page site running before the
 * user's first frame (the daemon seeds it from the image at boot), so the first arrival lands on it instead of
 * on an empty workspace with a tile they have no reason to press. Once per box, ever: previewSurface's stored
 * flag is what makes this a welcome rather than a habit, and any later visit goes wherever the user left off.
 *
 * Waits for the panels list to actually name the starter repo, not for a clock: on a fresh box the seed and
 * the first page load race, and `immediate` covers the boot that finished first. A workspace where the user
 * has since deleted the starter simply never matches, which is the correct amount of insistence.
 *
 * DESKTOP ONLY, deliberately: here the chat is docked beside the main area, so the site appears NEXT TO the
 * conversation, which is the whole point. A phone screen holds one surface at a time, and taking it for a
 * preview would be answering the arrival by hiding the chat. */
watch(
    panels,
    (list) => {
        // ONLY FROM THE LANDING, never over a place the reader asked for. `/` lands on the workspace, so that
        // is the one screen this replaces: somebody who opened a link straight to their agents or a terminal
        // said where they wanted to be, and a welcome that overrode it would be the shell talking over them.
        if (route.name === `workspace` && list.some((panel) => panel.repo === STARTER_REPO)) {
            openPreviewOnFirstVisit(router, appTargetId(STARTER_REPO, STARTER_APP));
        }
    },
    { immediate: true },
);

// The thin shell: the always-present areas plus the evidence-driven Preview above, then one tile per EXTENSION
// ACTIVATION: extensions detect workspace content (repo facts from /panels) and contribute their own sidebar
// elements (Infrastructure, Live status, one per monorepo, …): then the "+" Capabilities tile (rendered
// separately below). The Sandbox status/management view lives behind the switcher chip, not a rail tile. The
// rail is capability-first: a repo no extension serves lives only in the Workspace file tree.
const fixedTiles = computed<readonly AreaTile[]>(() => [
    // THE CHAT'S SEAT: see chatTileSeated for exactly when the rail holds one. First in the Work band because
    // talking to the agent is the product's primary surface; unbadged, because the Agents tile below carries
    // the debt.
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
        // `robot`, not `comments`, the Work-band tiles have to differ in SILHOUETTE, not in detail: a face,
        // a bubble (Chat above), a branching tree. The reasoning, and what it rules out, is on `robot` in the
        // icon table.
        icon: `robot`,
        // Both readings come from agentsTile.ts, which is also what the phone's tab bar draws: the count follows
        // the board's scope, and the note says so when it is wide (with the boxes that didn't answer named).
        // Phrased to follow the tile's name, which tileLabel puts in front of them: "Agents · 3 need you".
        ...(agentsBadge.value === undefined ? {} : { badge: agentsBadge.value }),
        ...(agentsScopeNote.value === undefined ? {} : { note: { icon: `boxes` as IconName, text: agentsScopeNote.value } }),
    },
    {
        id: `workspace`,
        to: `/workspace`,
        label: `Workspace`,
        // The other half of that pair: a branching tree, which is what this view opens on anyway.
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
 * happening now, and a rail count that never drops to zero stops meaning anything. The icon is `desktop`, not
 * `globe`: the ports-exposure indicator it sits beside already claims the globe. */
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
        // `neutral`, because "two browsers are open" is an inventory and not a debt: the tile says what the turn
        // has running, and nothing on the other end of it is waiting for the reader (viewBadge.ts). A browser
        // asking for the owner's hands IS a debt: the one moment this tile becomes a claim, it says so in the
        // warning tone and counts the browsers waiting rather than the ones merely open.
        ...(helping > 0
            ? { badge: { count: helping, tone: `warning` as const, tooltip: `the agent needs your help` } }
            : live > 0
              ? { badge: { count: live, tone: `neutral` as const, tooltip: `${live} open` } }
              : {}),
    };
});
/* Subagents, on exactly the browsers' terms above: it appears when a turn starts an agent, and its badge counts
 * only the ones still working. The third tile of this shape, because the three things a turn spawns that the
 * operator can look at (a shell, a browser, another agent) should not each be found a different way. */
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
        // Neutral for the browsers' reason: a subagent still working is this turn's own doing, not an errand.
        ...(live > 0 ? { badge: { count: live, tone: `neutral` as const, tooltip: `${live} still working` } } : {}),
    };
});
// The live-runtime cluster below the divider: the same AreaTile shape and the same markup as the navigation
// tiles above, so a badge is rendered in ONE place in this file rather than once per hand-rolled RouterLink.
const runtimeTiles = computed<readonly AreaTile[]>(() => [browserTile.value, subagentTile.value].filter((tile) => tile !== undefined));
// Activation.icon is an open string in the public extension API; the rail trusts it names one of the app's
// icons (an unknown name renders the icon set's fallback).
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
/* The navigation tiles, in ONE run ranked by RAIL_GROUPS: the core areas, then one tile per EXTENSION ACTIVATION
 * (extensions detect workspace content from /panels and contribute their own areas). Core tiles are not pinned
 * above the extensions: that pinning is what stopped an extension from being seated among them at all, which is
 * how Workflows came to sit in the rail's third seat with no way to say it belongs beside Automations.
 *
 * The sort is stable and detectActivations has already ranked the extensions by the same table, so activations a
 * table cannot order (one Deployments tile per Komodo connection) keep the order it gave them.
 *
 * Live runtime surfaces (browsers, subagents, forwarded ports, the terminal) are NOT here: they render in the
 * cluster below the divider, next to the "+" and account controls.
 *
 * EVERY AREA THIS WORKSPACE HAS, seated or not. What the column actually draws is `seatedTiles` below; the rest
 * of this list is the More menu's, and the two are cut from one run so an area can never be in both or neither. */
const tiles = computed<readonly AreaTile[]>(() =>
    [
        ...fixedTiles.value,
        ...detectActivations(panels.value, capabilities.value)
            // Only rail-surface extensions get a tile; per-repo directory panels (Apps, UI) open from
            // the Workspace tree instead, so the rail stays a short, capability-first list.
            .filter(({ extension }) => extension.surface === `rail`)
            .map(extensionTile),
    ].toSorted((left, right) => railRank(left.id) - railRank(right.id)),
);
/* THE RAIL IS COMPLETE: every source that can still add a navigation tile has answered. Extension tiles need
 * their extension activated AND the workspace facts their detect() reads, and those are three separate arrivals
 * on every load; until all three are in, a missing tile is late rather than absent, which is the distinction the
 * held seats below are built on. */
const railSettled = computed(() => extensionsLoaded.value && panelsSettled.value && capabilitiesSettled.value);

/* WHICH OF THEM ARE ON THE COLUMN RIGHT NOW. The rule and its exceptions live in the registry (railSeated), so
 * this is only the two live facts it needs: what this reader has pinned in this sandbox, and where they are
 * standing. The negative half is the More menu's list, taken from the same partition rather than recomputed,
 * because an area in neither run would simply be gone. */
const pins = useRailPins();
const seatedTiles = computed<readonly AreaTile[]>(() =>
    tiles.value.filter((tile) => railSeated(tile, { pinned: pins.pinned.value.has(tile.to), active: isNavActive(tile.to) })),
);
const moreTiles = computed<readonly AreaTile[]>(() => tiles.value.filter((tile) => !seatedTiles.value.includes(tile)));

/* THE SEATS WORTH REMEMBERING ARE THE ONES THAT WILL BE THERE TOMORROW: the permanent tiles and this reader's
 * pins. railMemory exists to stop the run assembling itself in front of the reader across a load (see its
 * header), and a signal-seated tile is not part of that problem: it is seated by a badge that is live state, so
 * a ghost held for it would be the rail promising a queue that may have been cleared since. Those tiles simply
 * light up when their extension answers, in a run whose length no longer moves while they do. */
const stableSeats = computed<readonly AreaTile[]>(() =>
    tiles.value.filter((tile) => seatPolicy(tile.id) === `always` || pins.pinned.value.has(tile.to)),
);
// The seats the rail had last time and hasn't filled yet: see railMemory.ts. Empty once the run is complete,
// and empty on a first-ever visit, so the rail this composes is the live one in every settled state.
const heldSeats = useRailMemory(stableSeats, railSettled);
/* What the column draws: the seated tiles, plus a held seat wherever one hasn't arrived, sorted by the SAME table
 * the live run uses, so each lands in the seat its tile will occupy and is replaced in place rather than shifting
 * anything. A seat and a tile of equal rank keep the live one first, which only happens between two activations
 * of one extension: adjacent, identical-looking seats where the order can't be seen. */
const railSeats = computed<readonly AreaTile[]>(() =>
    [...seatedTiles.value, ...heldSeats.value].toSorted((left, right) => railRank(left.id) - railRank(right.id)),
);
// The seats cut into their bands, so the template can draw a hairline between runs: held seats included, so
// the hairlines don't move in either as the run fills.
const tileBands = computed(() => railBands(railSeats.value, (tile) => tile.id));

/* ALT+↑/↓: WALK THE RAIL. The column is vertical, so the arrows ARE its axis, and the Alt+PageUp/PageDown
 * family next door keeps meaning what it means (the tabs WITHIN an area, resolved by focus): one modifier for
 * "move between things", the key saying which set. Bands are crossed silently: the hairlines group the tiles
 * for the eye, they are not stops.
 *
 * The NAVIGATION run only, not the live-runtime cluster below the divider. Browsers and Subagents appear the
 * moment a turn spawns one and leave when it is done, and a sequence whose length changes under the hand mid-
 * turn is not one a hand can learn; that cluster is runtime state, not an area (see browserTile).
 *
 * Wraps, like every other cycle in the shell. From a route no tile owns: the sandbox hub, /capabilities, a
 * runtime view: there is no "next" to be relative to, so the press enters the run at the end it is heading
 * away from: ↓ opens the first tile, ↑ the last. */
const cycleArea = (delta: number): void => {
    // The SEATED run, which is what the eye is following while the hand does this. An area behind the More menu
    // is reached by name (its `view.*` command) rather than by walking past it invisibly.
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
        // Keyboard navigation follows the tiles: cached workspace views remain useful while live actions wait
        // for exact reachability, so a transient stall must not strand the reader in one area.
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

// Where the rail-docked chat's "dock back to the side" returns to: the last route that wasn't the chat area.
// Tracked off the path the user actually stands on rather than history, which may START on /chat (a reload,
// a link).
watch(
    () => route.path,
    (path) => {
        if (!path.startsWith(`/chat`)) {
            lastAreaPath.value = path;
        }
    },
    { immediate: true },
);

/* WHERE A TILE'S CONTEXT MENU OPENS: hung off the COLUMN'S right edge, level with the tile it belongs to, never
 * under the pointer. PrimeVue's ContextMenu places one from the event's `pageX/pageY` alone, which is right for
 * a menu ABOUT A POINT (a spot in a file tree, a word in a transcript) and wrong for a 40px tile inside a 56px
 * column: opened at the pointer, the box landed half over the rail it was launched from. The synthetic event
 * below hangs it off the rail's right edge at the tile's top instead.
 *
 * A synthetic MouseEvent rather than a bare object: `show` calls `preventDefault`/`stopPropagation` on what it
 * is handed, and one missing them throws inside the menu instead of merely failing to be positioned. */
const showBesideRail = (menu: { show: (event: Event) => void } | undefined, event: MouseEvent): void => {
    const tile = event.currentTarget as HTMLElement | null;
    const rail = (tile?.closest(`nav`) ?? tile)?.getBoundingClientRect();
    const top = tile?.getBoundingClientRect().top;
    menu?.show(rail === undefined || top === undefined ? event : new MouseEvent(`click`, { clientX: rail.right, clientY: top }));
};

/* A TILE'S OWN MENU, which is two different menus depending on which tile it is.
 *
 * THE CHAT'S is where the chat goes next, asked of the thing that holds it. While the rail is the chat's home,
 * the tile IS the chat's presence in this window, so a right-click on it is the natural place to ask for one of
 * the other homes: back to the side column, or out into a window of its own. Rows share the one toggle each verb
 * already runs everywhere else (chatSurface.ts), and each carries its command's chord when one is bound.
 *
 * EVERY OTHER SEATED AREA'S is the pin, and only where a pin means something. A `signal` tile is on the rail
 * because it is badging and will leave when it stops; "Keep on the rail" is the reader saying that for this
 * sandbox they want it there regardless (railPins.ts). It is a checkable row rather than two labels, so the
 * state is legible before the press and the same row undoes it. The permanent tiles get no row at all: they
 * cannot be pinned (they are already), and offering to unpin Agents would be offering to break the rail. */
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
            // What the tile does when the pin is off, so the row explains itself rather than only toggling:
            // this is the one place the seat rule is stated to the person it applies to.
            hint: pins.isPinned(tile.to) ? `Always seated, badge or not` : `Otherwise it shows only when it needs you`,
            checked: pins.isPinned(tile.to),
            command: (): void => pins.toggle(tile.to),
        },
    ];
});
const onTileContextMenu = (tile: RailSeat, event: MouseEvent): void => {
    if (tile.id !== `chat` && seatPolicy(tile.id) === `always`) {
        return; // a permanent tile has nothing to offer here: keep the browser's own menu
    }
    event.preventDefault();
    menuTile.value = tile;
    showBesideRail(tileMenu.value, event);
};

/* THE DOOR TO EVERYTHING THAT IS NOT ON THE RAIL, and the reason the rest of the column may be short. It is a
 * permanent tile listing every area this workspace has that is not currently seated: quiet queues, the surfaces
 * that never badge, anything the reader has not pinned. One seat, held forever, in exchange for the eight it
 * takes back.
 *
 * ROWS ARE LINKS, same as the sandbox switcher and account menus: real URLs so middle-click, ⌘-click and "copy
 * link address" work on a place found through the menu rather than through the rail.
 *
 * IT NEVER BADGES, and it cannot: anything with something to say is seated by that very fact, so a count here
 * could only ever be zero. A More tile that lit up would mean the seat rule had stopped working. */
const moreTrigger = ref<HTMLButtonElement | null>(null);
const moreOpen = ref(false);
// The count is the whole point of the hover: the tile's job is to say that there is more, and how much more is
// the only thing a reader can't already see. Phrased like every other tile's label (see tileLabel).
const moreLabel = computed(() => (moreTiles.value.length === 0 ? `More areas` : `More areas · ${moreTiles.value.length} not on the rail`));
const dismissMore = (event: MouseEvent): void => {
    if (!browserOwnsClick(event)) {
        moreOpen.value = false;
    }
};

// Collapse the chat column to nothing whenever the panel does not live in it: teleported into its own window
// (popped out), on its way back to one after a page reload (so a refresh doesn't flash the column open for a
// few frames), or homed on the RAIL, where the chat is the /chat area and, away from it, waits parked behind
// the tile rather than reappearing as a column beside other views. The workspace reclaims the full width in
// all of them. The rail variables flow into its child
// controls too, keeping every tile on one density without threading a presentation-only prop through the
// switcher and account components.
// THE RAIL DOES NOT TAKE THE APP'S TEXT SIZE. Everything else on screen grows with it: that is the point of
// the setting, but the rail is chrome, not content: it carries no prose to read, its tiles are already at a
// comfortable hit size, and every pixel it gains is a pixel taken from the work beside it. So each of its
// measures divides the bump back out (--ui-scale, see tokens.css), which holds the column at exactly the
// footprint it has today while still tracking a reader who has raised their browser's own base font. The
// glyphs inside the tiles are the one part that does grow, by a pixel or two, so the rail's icons stay in
// proportion with the app's type instead of shrinking away from it.
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

// The global terminal panel's open state, for the rail tile that toggles it (Ctrl+` does the same from
// anywhere in the shell). The panel itself docks into the slot below the workspace: tmux sessions are
// sandbox-global facts, so shells and dev servers stay visible while navigating.
const terminal = useTerminalPanel();
// The ship-and-operate tier's tile: a PTY is a shell over the whole sandbox, so viewers and collaborators
// don't get the affordance (the daemon refuses the WebSocket below maintainer regardless).
const { canShip } = useRole();
// The rail's terminal entry: the ONLY visible affordance for the panel (the Workspace view no longer carries a
// toggle: terminals are sandbox-global, so their control belongs on the sandbox-global surface). It doubles as
// an indicator: the badge counts live sessions and the tooltip names them, so the shells and dev servers the
// agent and the extensions started are legible with the panel closed.
const terminalActivity = useTerminalActivity();
const terminalLabel = computed(() => {
    const chord = commandShortcut(`terminal.toggle`);
    const what = terminalActivity.summary.value === undefined ? `Terminal` : `Terminal, ${terminalActivity.summary.value} running`;
    return chord === undefined ? what : `${what} (${chord})`;
});
// The core shell's built-in Command Palette commands (navigation, terminal, chat pop-out, Go to File / Command
// Palette): registered on mount, disposed on unmount, so the `>` command mode is populated the moment the shell
// is up. Each carries its own `keybinding`, so it is reachable by both the palette and a shortcut.
useShellCommands();
// …and one "Go to <area>" per rail area on top of them, seated or not: what keeps a surface behind the More
// menu one keystroke away rather than one hunt away (useAreaCommands.ts).
useAreaCommands();
// The single global-shortcut dispatcher: it runs whichever registered command's keybinding matches the keystroke
// (Ctrl+` → terminal, Mod+P → Go to File, Mod+Shift+P → Command Palette, plus any extension-contributed binding),
// replacing a bespoke per-shortcut hub. All actions are sandbox-global, so it lives at the shell, not in a view.
useKeybindings();
</script>

<template>
    <div class="shell grid h-screen overflow-hidden bg-canvas text-content" :style="gridStyle">
        <nav class="icon-rail flex flex-col items-center border-r border-line bg-card" style="grid-area: rail">
            <!-- Top of the rail: the active sandbox's identity chip, switch between the user's sandboxes (owned +
                 shared), add another, or manage access. -->
            <SandboxSwitcher />
            <!-- The other members connected to this sandbox right now: live from the daemon's /events roster. -->
            <PresenceAvatars :members="presenceOthers" direction="column" :size="28" />
            <span class="mb-1 icon-rail-divider h-px bg-line"></span>

            <!-- The navigation tiles, in bands (Work / Judge / Know: see RAIL_GROUPS) separated by WHITESPACE,
                 never by a line. A 44px column has no room for a heading, so the gap between runs IS the
                 heading; the mobile menu, which has the width, spells them out. THIS is the one part of the
                 rail that scrolls: see .icon-rail-nav.

                 ONE DEVICE PER JOB, and this is the half of that rule the bands hold up. The rail draws exactly
                 three kinds of thing in one column: who you are here (the switcher, presence), where you work
                 (these tiles and the More door), and what is running on the machine right now (VPN, ports,
                 browsers, subagents, the terminal). A hairline marks each of those two boundaries and nothing
                 else, so a line in this rail means "different kind of thing" and always has.

                 The bands used to be drawn with the same hairline, which made five identical seams saying two
                 different things, and left the reader to guess which was which from position alone. The guess
                 they landed on was a scope boundary: with the chat docked (chatHome defaults to `side`) the run
                 opens Agents, Workspace, Preview, and the first line under it read as "the views above are
                 about all your sandboxes, the ones below are about this box". It never meant that. Agents is
                 the only surface with a scope at all, it is a setting the reader chose rather than a property
                 of the tile, and the tile says so itself now (see agentsTile's mark and its badge).

                 Navigation remains live while the daemon catches up: cached views are still useful, and the
                 workspace gate itself decides whether there is anything truthful to paint. Actions inside a
                 view keep using exact reachability. -->
            <div class="icon-rail-nav flex flex-col items-center overflow-y-auto overscroll-contain">
                <template v-for="(band, at) in tileBands" :key="band.group.id">
                    <!-- The band seam: air, in the same quantity the hairline's box used to take, so the run's
                         rhythm is unchanged and only the line is gone. aria-hidden because a band boundary is a
                         reading aid for the eye; the tiles carry their own labels and a screen reader walks them
                         as one list, which is what the list IS. -->
                    <span v-if="at > 0" class="icon-rail-band" aria-hidden="true"></span>
                    <template v-for="tile in band.items" :key="tile.to">
                        <!-- A SEAT BEING HELD, not a tile: this one was in the rail last time and hasn't loaded
                             back yet (railMemory.ts). It draws the glyph it will draw, dim and pulsing, so the
                             tile lights up in place instead of pushing everything under it down as it arrives.
                             Not focusable and hidden from assistive tech: there is nothing here to act on, and
                             a screen reader announcing a link that doesn't exist yet would be worse than the
                             silence. -->
                        <span
                            v-if="tile.ghost"
                            class="icon-rail-tile flex animate-pulse items-center justify-center rounded-lg bg-overlay/50 text-muted opacity-40"
                            aria-hidden="true"
                        >
                            <span v-if="tile.icon === undefined" class="text-sm font-semibold">{{ initialsOf(tile.label) }}</span>
                            <Icon v-else :name="tile.icon!" class="text-lg" />
                        </span>
                        <RouterLink
                            v-else
                            :to="tile.to"
                            class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                            :class="{ 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                            :aria-label="tileLabel(tile)"
                            v-tooltip.right="tileLabel(tile)"
                            @contextmenu="onTileContextMenu(tile, $event)"
                        >
                            <span v-if="tile.icon === undefined" class="text-sm font-semibold">{{ initialsOf(tile.label) }}</span>
                            <Icon v-else :name="tile.icon!" class="text-lg" />
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
                            <!-- The tile's standing note (AreaTile.note): the OPPOSITE corner from the badge, so
                                 the two never overlap on a tile carrying both, and in the rail's muted ink with
                                 no plate behind it: it is not an errand and must not compete with a count that
                                 is. Hidden from assistive tech because its sentence is already in the tile's own
                                 aria-label, where a screen reader reaches it as part of the link rather than as a
                                 second nameless element. -->
                            <span v-if="tile.note" class="absolute bottom-0.5 left-0.5 flex leading-none text-subtle" aria-hidden="true">
                                <Icon :name="tile.note.icon" class="text-[0.6rem]" />
                            </span>
                        </RouterLink>
                    </template>
                </template>
            </div>

            <!-- MORE: every area this workspace has that is not currently seated above. OUTSIDE the scrolling run on purpose, and directly under it: it is the answer to "where did the
                 rest go", so it is the one navigation control that must never be the thing scrolled out of
                 sight. Dashed like the "+" below it, because both are doors rather than places, and it lights
                 in the rail's one accent while its menu is open so the press has an answer on screen.

                 NO HOVER LABEL WHILE THE LIST IS OPEN: the tooltip opens to the right of this tile and so does
                 the menu, so a pointer coming back over the tile drew the label across the menu's first row. The
                 label answers "what is this button", and once the list is up that question has been answered at
                 length. The directive drops its box when the value goes away (ui/lib/tooltip.ts). -->
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
                <Icon name="ellipsis" class="text-lg" />
            </button>

            <!-- Same surface as the sandbox switcher and account avatar: AnchoredOverlay rows, not PrimeVue's
                 ContextMenu, which paints a different box on the same rail. -->
            <AnchoredOverlay v-model="moreOpen" :anchor="moreTrigger ?? undefined" side="right" cross="start">
                <div class="flex w-48 flex-col gap-0.5 p-1">
                    <p v-if="moreTiles.length === 0" class="px-2 py-1.5 text-xs text-subtle">Every area is on the rail</p>
                    <RouterLink
                        v-for="tile in moreTiles"
                        :key="tile.to"
                        :to="tile.to"
                        class="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                        @click="dismissMore"
                    >
                        <span v-if="tile.icon !== undefined" class="flex h-5 w-5 shrink-0 items-center justify-center">
                            <Icon :name="tile.icon" class="text-xs text-muted" />
                        </span>
                        <span class="min-w-0 flex-1 truncate">{{ tile.label }}</span>
                    </RouterLink>
                </div>
            </AnchoredOverlay>

            <span class="my-1 icon-rail-divider h-px bg-line"></span>

            <!-- The VPN indicator: present ONLY while a tunnel is up, because that is a fact about the sandbox
                 the operator must be able to see from any view, while it is connected, the agent's traffic,
                 git and package installs leave through someone else's network. Links to the Status card that
                 owns the controls. -->
            <RouterLink
                v-if="connectedVpns.length > 0"
                to="/sandbox/status"
                class="icon-rail-tile flex items-center justify-center rounded-lg text-success transition-colors hover:bg-overlay"
                :aria-label="vpnLabel"
                v-tooltip.right="vpnLabel"
            >
                <Icon name="shield" class="text-lg" />
            </RouterLink>

            <!-- The exposure indicator: present ONLY while a port is forwarded, because that is when something
                 inside the sandbox is answering the public internet. Links to the Ports tab, which owns the
                 controls (and the "Stop" that revokes it). -->
            <RouterLink
                v-if="forwardedPorts.length > 0"
                to="/sandbox/ports"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-warning transition-colors hover:bg-overlay"
                :aria-label="forwardedLabel"
                v-tooltip.right="forwardedLabel"
            >
                <Icon name="globe" class="text-lg" />
                <span
                    v-if="forwardedPorts.length > 1"
                    class="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-warning/15 px-1 text-center text-[0.6rem] font-semibold leading-4 text-warning"
                    >{{ forwardedPorts.length }}</span
                >
            </RouterLink>

            <!-- The agent's browsers and subagents: live-runtime surfaces like the terminal, so they sit in
                 this cluster rather than with the navigation tiles above. Each is badged with what is still
                 RUNNING (see browserTile/subagentTile), and each renders through the same markup as a
                 navigation tile: they are AreaTiles, and one badge renderer is the point of that shape. -->
            <RouterLink
                v-for="tile in runtimeTiles"
                :key="tile.to"
                :to="tile.to"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                :aria-label="tileLabel(tile)"
                v-tooltip.right="tileLabel(tile)"
            >
                <Icon :name="tile.icon!" class="text-lg" />
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

            <!-- The terminal: toggles the one global panel from any view, highlighted while it is open, badged
                 with the number of live sessions (shells, dev servers, agent shells, jobs: background
                 processes are excluded, they never idle). Inert while the daemon is unreachable: unlike cached
                 route content, opening a PTY has no useful offline form. Absent
                 below maintainer: a PTY is the whole sandbox, and the daemon refuses the socket anyway. -->
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
                <Icon name="code" class="text-lg" />
                <span
                    v-if="terminalActivity.count.value > 0"
                    class="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary-600/15 px-1 text-center text-[0.6rem] font-semibold leading-4 text-link"
                    >{{ terminalActivity.count.value > 99 ? "99+" : terminalActivity.count.value }}</span
                >
            </button>

            <!-- Add a capability (a repo / internal tool / external tool): the /capabilities page; every "add"
                 is a write to the sandbox's deploy.config.ts or a clone into /work, never platform storage.

                 Standing on that page lights this tile in the rail's ONE accent, exactly like every navigation
                 tile above: the dashed "+" keeps its own resting shape, but "you are here" is a single claim
                 and the rail may not say it in two colours: a grey plate here read as a hover, not a place. -->
            <RouterLink
                to="/capabilities"
                :class="[
                    ui.addTile(`icon-rail-tile rounded-lg hover:bg-overlay`),
                    { 'border-link bg-primary-600/15 text-link': isNavActive('/capabilities') },
                ]"
                aria-label="Add a capability"
                v-tooltip.right="'Add a capability'"
            >
                <Icon name="plus" class="text-lg" />
            </RouterLink>

            <!-- The account control: avatar → a rich popover (central account, sandbox workspace, theme, actions). -->
            <AccountPanel />
        </nav>

        <!-- The chat's place in the grid: a slot, not the panel. The panel is mounted above the router and
             teleported in here (shell/dockSlots.ts), so the same live DOM serves the column, the floating window
             and a route this shell doesn't cover; `display: contents` means this element is not in the layout
             at all and the panel itself is still the grid item. -->
        <div ref="chatDock" class="contents"></div>

        <main class="relative flex min-w-0 flex-col overflow-hidden" style="grid-area: workspace">
            <SandboxGate>
                <div class="min-h-0 flex-1 overflow-auto scrollbar-thin">
                    <RouterView />
                </div>
                <!-- …and the same for the ONE terminal panel: sandbox-global (shells + dev servers), persistent
                     across views. Its slot is INSIDE the gate, which is what keeps a docked terminal off screen
                     for an initial/blocked connection: through a transient stall it stays mounted and its own
                     socket recovery keeps the last scrollback visible. -->
                <div ref="terminalDock" class="contents"></div>
            </SandboxGate>
        </main>

        <!-- Quick Open (Ctrl/Cmd+P) file palette: a Dialog that portals to body, so it overlays the whole shell
             regardless of where it sits in the grid. -->
        <QuickOpen />

        <!-- A tile's right-click menu (see tileMenuItems): the chat's homes, or the pin. Main window only, so
             the default body. -->
        <ContextMenu ref="tileMenu" :model="tileMenuItems" :min-width="15" />
    </div>
</template>

<style scoped>
.shell {
    /* The chat track's floor is 0, not its asked width: the stored column width (useLayout) was clamped against
     * the window at the moment it was dragged, so a window shrunk since, or a restore onto a smaller screen:
     * would otherwise push the column past the right edge and let overflow:hidden take the composer's margin
     * with it. minmax lets the track shrink to what is left beside the rail instead of clipping. */
    grid-template-columns: var(--icon-rail-width) minmax(0, 1fr) minmax(0, var(--chat-width, 22rem));
    /* One real row fills 100vh; a stray fixed-position overlay anchor landing in an implicit row would let 1fr
     * starve it to 0 and split the height (see CLAUDE.md post-mortem). Pin a single explicit row so none can. */
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: "rail workspace chat";
}

.icon-rail {
    gap: var(--icon-rail-gap);
    padding-block: var(--icon-rail-padding);
    /* A faint accent wash so switching colours shifts the rail, not only buttons and links. An inset shadow
     * layers on top of any background-image a skin may set (sanctum's stone), so it does not fight specificity
     * the way a background-image rule from a scoped style would. */
    box-shadow: inset 0 0 0 100vmax color-mix(in oklab, var(--color-brand-950) 8%, transparent);
}

/* NOTHING IN THE RAIL MAY BE SQUASHED. A column flex item defaults to flex-shrink: 1, and .icon-rail-tile sets
 * `height`, not `min-height`, so a rail that outgrew the viewport did not overflow or scroll, it silently
 * compressed its tiles toward their content height. Measured before this rule, with 14 nav + 7 system tiles:
 * the 44px nav tiles rendered at 24px on an 800–945px viewport and 28px at 1080px, with no scrollbar and
 * nothing clipped: they simply stopped being squares and lost nearly half their hit target. The nav tiles took
 * all of it while the seven outside kept their size, because shrinkage is distributed by flex-basis and the nav
 * run is by far the largest item in the column: the more extensions registered a tile, the more the tiles paid
 * and the less anything else did. With the rule, 21/21 tiles hold 44px at every viewport and the nav scrolls
 * (9 nav tiles fit at 945px, 11 at 1080px). */
.icon-rail > *,
.icon-rail-tile,
.icon-rail-band,
.icon-rail-divider {
    flex-shrink: 0;
}

/* A BAND BOUNDARY INSIDE THE NAVIGATION RUN, drawn as air. One gap unit, so a band seam is three of them
 * (gap + this + gap) against one within a band: the same three-to-one rhythm the hairline's box carried, minus
 * the 3px the line and its margins spent (9px → 6px at compact size). It scales with the rail, because the gap
 * it copies is `rail()`-derived like every other length in the column, and it costs the scrolling run slightly
 * LESS height than the line did, which is the direction to err on a column that runs out of fold. */
.icon-rail-band {
    height: var(--icon-rail-gap);
}

/* The one part that gives. The nav tiles are the run that grows without bound (one per extension activation), so
 * they are the run that scrolls: leaving the switcher above and the terminal / "+" / account below anchored
 * where the hand already expects them, however many extensions register a tile. It shrinks only under pressure
 * (min-height: 0, no flex-grow), so on a rail that fits, the layout is unchanged. */
.icon-rail-nav {
    flex-shrink: 1;
    min-height: 0;
    gap: var(--icon-rail-gap);
    /* A scrollbar in a 44px column would eat a quarter of it and sit under the tiles; the seam above and below
     * is what says there is more, and the tiles scroll under the finger regardless. */
    scrollbar-width: none;
}

.icon-rail-nav::-webkit-scrollbar {
    display: none;
}

.icon-rail-tile {
    width: var(--icon-rail-tile-size);
    height: var(--icon-rail-tile-size);
}

.icon-rail-divider {
    width: var(--icon-rail-divider-width);
}
</style>
