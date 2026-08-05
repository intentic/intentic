<script setup lang="ts">
import type { Disposable, ViewBadge } from "@intentic/extension-api";
// `initialsOf` is the rail tile's glyph for a repository (my-shop-api → MS), so repositories stay
// distinguishable instead of all sharing one icon — the same monogram <Avatar> and <BrandMark> fall back to.
import { type IconName, initialsOf } from "@intentic/ui";
import { computed, onMounted, onUnmounted } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { useAgents } from "../composables/agents/useAgents";
import { useBrowsersQuery } from "../composables/browser/browsersQuery";
import { useSubagentsQuery } from "../composables/subagents/subagentsQuery";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useDrafts } from "../composables/extensions/useDrafts";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useTerminalActivity } from "../composables/terminal/useTerminalActivity";
import { commandShortcut, registerCommand } from "../composables/commands/useCommands";
import { type ActiveExtension, activationBadge, detectActivations, extensionPath, railBands, railRank } from "../core-views/registry";
import { badgeClass, badgeText } from "../core-views/viewBadge";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useShellCommands } from "../composables/commands/useShellCommands";
import { useKeybindings } from "../composables/commands/useKeybindings";
import { useLayout } from "../composables/useLayout";
import { useIconRailSize } from "../composables/useIconRailSize";
import { presenceOthers } from "../composables/usePresence";
import { usePanels } from "../composables/extensions/usePanels";
import { outgoingMark, outgoingSummary } from "../composables/workspace/outgoingWork";
import { useChanges } from "../composables/workspace/useChanges";
import { usePorts } from "../composables/sandbox/usePorts";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useVpn } from "../composables/sandbox/useVpn";
import AccountPanel from "./AccountPanel.vue";
import { chatDock, terminalDock } from "./dockSlots";
import PresenceAvatars from "../presence/PresenceAvatars.vue";
import QuickOpen from "./QuickOpen.vue";
import SandboxGate from "../sandbox-gates/SandboxGate.vue";
import SandboxSwitcher from "../sandbox-gates/SandboxSwitcher.vue";

interface AreaTile {
    // The rail element's id — a core shell tile's own name, or the contributing extension's id. It is what
    // RAIL_GROUPS ranks and groups by, so core tiles and extension tiles sort against ONE table (see registry.ts)
    // instead of core tiles being pinned above and extensions ordered among themselves.
    readonly id: string;
    // The route the tile links to (e.g. /workspace, /panel/app).
    readonly to: string;
    readonly label: string;
    // An `IconName` for the fixed areas; undefined for a repository tile, which renders its initials instead.
    readonly icon?: IconName;
    // What the tile says without being opened. The same shape core areas and extensions both fill, so the rail
    // renders ONE badge element instead of a hardcoded span per route.
    readonly badge?: ViewBadge;
}

// ONE label per tile, badge included. The badge used to carry a tooltip of its own, nested inside the tile's —
// and `mouseenter` fires on an element AND every ancestor it entered, so hovering the count opened both boxes,
// one over the other ("Browsers" behind "1 agent browser open"). What the badge says is a fact ABOUT the tile,
// so it belongs in the tile's own label rather than on a second anchor 16px wide. It matters more since the
// badge grew a `mark`: a glyph states only THAT something is waiting, and the sentence carrying how much is
// then the only place the amount exists.
const tileLabel = (tile: AreaTile): string => (tile.badge?.tooltip === undefined ? tile.label : `${tile.label} · ${tile.badge.tooltip}`);

/* The desktop chrome of the post-login shell: a square-tile rail, the shared Claude Code chat panel, and a
 * workspace outlet for the active area. Layout is a three-column CSS grid; the chat width is driven by a
 * `--chat-width` CSS variable (useLayout), which the chat panel's drag handle updates. The shared (device-
 * independent) lifecycle — liveness, presence, plan — lives in WorkspaceShell, which picks this or ShellMobile. */

const { panels } = usePanels();
const { capabilities } = useCapabilities();
// Drafts is agent-driven; its tile is permanent and the badge carries how much is owed (see draftsBadge).
const { owed: draftsOwed, broken: draftsBroken } = useDrafts();
// The agent's browsers, on the same appear-on-content terms. Polled loosely: this is the always-on read that
// makes the tile show up mid-turn, and the view itself polls tighter once it is on screen.
const { sessions: browsers } = useBrowsersQuery(10_000);
// The agents this sandbox's agents started, on the same loose beat and for the same reason: this is the always-on
// read that makes the tile appear the moment a turn delegates; the area polls tighter once it is on screen.
const { sessions: subagents, running: runningSubagents } = useSubagentsQuery(10_000);
const { reachable } = useSandbox();
// Uncommitted workspace changes surface as a count badge on the Workspace rail tile, visible from any area.
const changes = useChanges();
// "Agents need you" (pending plans/questions, land conflicts, unread finishes) badges the Agents tile.
const { attention: agentAttention } = useAgents();
const layout = useLayout();
const { iconRailSize } = useIconRailSize();
// Only what the LAYOUT needs: a popped-out (or returning) chat is a collapsed column. The panel itself is
// mounted above the router now — this shell just lends it the column (see the slot in the template).
const { poppedOut, restoring: chatRestoring } = useChatPopout();
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
// its hostname until someone stops it, so the fact belongs on the surface that is visible from every view —
// not behind the Ports tab it is managed from. Absent while nothing is forwarded, which is the whole signal.
const { forwarded: forwardedPorts } = usePorts();
const forwardedLabel = computed(() =>
    forwardedPorts.value.length === 1
        ? `Port ${forwardedPorts.value[0]?.port} is publicly reachable`
        : `${forwardedPorts.value.length} ports are publicly reachable: ${forwardedPorts.value.map((entry) => entry.port).join(`, `)}`,
);

// A rail link is active for its route AND any sub-path — `active-class` can't do this: with a splat/optional
// param (workspace/:path, capabilities/:card) it compares params and drops the highlight the moment one is set
// (a file open on /workspace, a card open on /capabilities). Prefix match, harmless for the param-less tiles.
const isNavActive = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);

/* What the Workspace tile says, in the priority the panel behind it already uses: the commit box owns the
 * primary slot until there is nothing left to commit, and only then does it hand that slot to the sync — so the
 * tile is a miniature of it, and the two can never disagree about what the next move is.
 *
 * A COUNT, THEN A GLYPH. The count is for work whose size decides how you spend the next hour: two changed
 * files and two hundred are different afternoons. Outgoing commits are not that — three or thirty, it is one
 * click — so a number there would only be misread in the unit the count established one state earlier. The
 * glyph says which KIND of work is waiting, and the tooltip says how much.
 *
 * That the user committed it themselves is no argument for staying silent: on this workspace an AGENT usually
 * did, and the tree it left behind is clean. */
const workspaceBadge = computed<ViewBadge | undefined>(() => {
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

/* WHAT THE DRAFTS TILE SAYS — the queue's own `owed` count (useDrafts defines it and says why it excludes what it
 * excludes). Danger tone once something is broken rather than merely waiting: a post that failed and a post
 * awaiting approval want different afternoons, and a bare number cannot say which is in it. */
const draftsBadge = computed<ViewBadge | undefined>(() => {
    const owed = draftsOwed.value;
    const broken = draftsBroken.value;
    if (owed === 0) {
        return undefined;
    }
    // Phrased to follow the tile's name, which tileLabel puts in front of it: "Drafts · 3 waiting on you".
    const tooltip =
        broken === 0 ? `${owed} waiting on you` : owed === broken ? `${broken} failed to post` : `${owed} waiting on you, ${broken} failed to post`;
    return { count: owed, ...(broken > 0 ? { tone: `danger` } : {}), tooltip };
});

// The thin shell: three always-present areas, then one tile per EXTENSION ACTIVATION — extensions detect
// workspace content (repo facts from /panels) and contribute their own sidebar elements (Infrastructure, Live
// status, one per monorepo, …) — then the "+" Capabilities tile (rendered separately below). The Sandbox
// status/management view lives behind the switcher chip, not a rail tile. The rail is capability-first: a repo
// no extension serves lives only in the Workspace file tree.
const fixedTiles = computed<readonly AreaTile[]>(() => [
    {
        id: `agents`,
        to: `/agents`,
        label: `Agents`,
        icon: `comments`,
        ...(agentAttention.value > 0
            ? {
                  badge: {
                      count: agentAttention.value,
                      // Phrased to follow the tile's name, which tileLabel puts in front of it: "Agents · 3 need you".
                      tooltip: `${agentAttention.value} need${agentAttention.value === 1 ? `s` : ``} you`,
                  },
              }
            : {}),
    },
    {
        id: `workspace`,
        to: `/workspace`,
        label: `Workspace`,
        icon: `folder`,
        ...(workspaceBadge.value === undefined ? {} : { badge: workspaceBadge.value }),
    },
    /* PERMANENT, AND THE BADGE CARRIES THE QUEUE. Drafts used to appear only once something was waiting, which made
     * it the one navigation tile whose arrival re-seated every tile beneath it — and it arrived on someone else's
     * schedule, an agent proposing a post overnight. A column that moves under the hand has to be re-read. It is
     * now an AREA on the terms ext-maintenance argued for its own: the surface exists whether or not anything is in
     * it, so it can be visited to confirm the queue is empty, and the badge rather than the tile's existence is the
     * signal. The phone has always worked this way — its "Review" tab is fixed and badges the same fact.
     *
     * A core shell surface, not an extension (the mobile bottom bar depends on it too). Where it lands among the
     * others is RAIL_GROUPS' call like every other tile's, not a splice here. */
    {
        id: `drafts`,
        to: `/drafts`,
        label: `Drafts`,
        icon: `send`,
        ...(draftsBadge.value === undefined ? {} : { badge: draftsBadge.value }),
    },
]);
/* Browsers appears the moment a turn opens one and stays while the daemon still lists it — a rail tile that
 * tracks live work rather than a permanent surface. It renders in the rail's live-runtime cluster (next to the
 * ports indicator and the terminal), not among the navigation tiles: a browser session is runtime state like a
 * tmux session, not an area like Agents or Workspace. The badge counts RUNNING browsers only: a finished one is
 * still readable in the view (its pages are the record of where the agent went) but it is not something
 * happening now, and a rail count that never drops to zero stops meaning anything. The icon is `desktop`, not
 * `globe` — the ports-exposure indicator it sits beside already claims the globe. */
const browserTile = computed<AreaTile | undefined>(() => {
    if (browsers.value.length === 0) {
        return undefined;
    }
    const live = browsers.value.filter((session) => session.running).length;
    return {
        id: `browsers`,
        to: `/browsers`,
        label: `Browsers`,
        icon: `desktop`,
        ...(live > 0 ? { badge: { count: live, tooltip: `${live} open` } } : {}),
    };
});
/* Subagents, on exactly the browsers' terms above: it appears when a turn starts an agent, and its badge counts
 * only the ones still working. The third tile of this shape, because the three things a turn spawns that the
 * operator can look at — a shell, a browser, another agent — should not each be found a different way. */
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
        ...(live > 0 ? { badge: { count: live, tooltip: `${live} still working` } } : {}),
    };
});
// The live-runtime cluster below the divider — the same AreaTile shape and the same markup as the navigation
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
 * above the extensions — that pinning is what stopped an extension from being seated among them at all, which is
 * how Workflows came to sit in the rail's third seat with no way to say it belongs beside Automations.
 *
 * The sort is stable and detectActivations has already ranked the extensions by the same table, so activations a
 * table cannot order (one Deployments tile per Komodo connection) keep the order it gave them.
 *
 * Live runtime surfaces (browsers, subagents, forwarded ports, the terminal) are NOT here — they render in the
 * cluster below the divider, next to the "+" and account controls. */
const tiles = computed<readonly AreaTile[]>(() =>
    [
        ...fixedTiles.value,
        ...detectActivations(panels.value, capabilities.value)
            // Only rail-surface extensions get a tile; per-repo directory panels (Apps, UI, preview) open from
            // the Workspace tree instead, so the rail stays a short, capability-first list.
            .filter(({ extension }) => extension.surface === `rail`)
            .map(extensionTile),
    ].toSorted((left, right) => railRank(left.id) - railRank(right.id)),
);
// The tiles cut into their bands, so the template can draw a hairline between runs.
const tileBands = computed(() => railBands(tiles.value, (tile) => tile.id));

/* ALT+↑/↓ — WALK THE RAIL. The column is vertical, so the arrows ARE its axis, and the Alt+PageUp/PageDown
 * family next door keeps meaning what it means (the tabs WITHIN an area, resolved by focus): one modifier for
 * "move between things", the key saying which set. Bands are crossed silently — the hairlines group the tiles
 * for the eye, they are not stops.
 *
 * The NAVIGATION run only, not the live-runtime cluster below the divider. Browsers and Subagents appear the
 * moment a turn spawns one and leave when it is done, and a sequence whose length changes under the hand mid-
 * turn is not one a hand can learn; that cluster is runtime state, not an area (see browserTile).
 *
 * Wraps, like every other cycle in the shell. From a route no tile owns — the sandbox hub, /capabilities, a
 * runtime view — there is no "next" to be relative to, so the press enters the run at the end it is heading
 * away from: ↓ opens the first tile, ↑ the last. */
const cycleArea = (delta: number): void => {
    const list = tiles.value;
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
        // Gated on `reachable`, exactly as the tiles themselves are inert while the daemon is unreachable: every
        // area behind them is served by that machine, so a chord that navigates there would only swap one gate
        // screen for another. (The sandbox switcher above deliberately does NOT gate — that is the way out.)
        registerCommand({
            owner: `builtin`,
            command: `view.previousArea`,
            title: `Previous Rail Area`,
            icon: `chevron-up`,
            keybinding: `Alt+ArrowUp`,
            when: () => reachable.value,
            handler: () => cycleArea(-1),
        }),
        registerCommand({
            owner: `builtin`,
            command: `view.nextArea`,
            title: `Next Rail Area`,
            icon: `chevron-down`,
            keybinding: `Alt+ArrowDown`,
            when: () => reachable.value,
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

// Collapse the chat column to nothing while the panel is popped out (it's teleported into its own window), so
// the workspace reclaims the full width — and equally while a window from before a page reload is still on its
// way back, so a refresh doesn't flash the column open for a few frames. The rail variables flow into its child
// controls too, keeping every tile on one density without threading a presentation-only prop through the
// switcher and account components.
const gridStyle = computed(() => {
    const compact = iconRailSize.value === `compact`;
    return {
        "--chat-width": poppedOut.value || chatRestoring.value ? `0px` : `${layout.chatWidth.value}px`,
        "--icon-rail-width": compact ? `3.5rem` : `4rem`,
        "--icon-rail-tile-size": compact ? `2.5rem` : `2.75rem`,
        "--icon-rail-account-size": compact ? `2rem` : `2.25rem`,
        "--icon-rail-divider-width": compact ? `1.75rem` : `2rem`,
        "--icon-rail-gap": compact ? `0.375rem` : `0.5rem`,
        "--icon-rail-padding": compact ? `0.5rem` : `0.75rem`,
    };
});

// The global terminal panel's open state, for the rail tile that toggles it (Ctrl+` does the same from
// anywhere in the shell). The panel itself docks into the slot below the workspace — tmux sessions are
// sandbox-global facts, so shells and dev servers stay visible while navigating.
const terminal = useTerminalPanel();
// The rail's terminal entry: the ONLY visible affordance for the panel (the Workspace view no longer carries a
// toggle — terminals are sandbox-global, so their control belongs on the sandbox-global surface). It doubles as
// an indicator: the badge counts live sessions and the tooltip names them, so the shells and dev servers the
// agent and the extensions started are legible with the panel closed.
const terminalActivity = useTerminalActivity();
const terminalLabel = computed(() => {
    const chord = commandShortcut(`terminal.toggle`);
    const what = terminalActivity.summary.value === undefined ? `Terminal` : `Terminal — ${terminalActivity.summary.value} running`;
    return chord === undefined ? what : `${what} (${chord})`;
});
// The core shell's built-in Command Palette commands (navigation, terminal, chat pop-out, Go to File / Command
// Palette) — registered on mount, disposed on unmount, so the `>` command mode is populated the moment the shell
// is up. Each carries its own `keybinding`, so it is reachable by both the palette and a shortcut.
useShellCommands();
// The single global-shortcut dispatcher: it runs whichever registered command's keybinding matches the keystroke
// (Ctrl+` → terminal, Mod+P → Go to File, Mod+Shift+P → Command Palette, plus any extension-contributed binding),
// replacing a bespoke per-shortcut hub. All actions are sandbox-global, so it lives at the shell, not in a view.
useKeybindings();
</script>

<template>
    <div class="shell grid h-screen overflow-hidden bg-canvas text-content" :style="gridStyle">
        <nav class="icon-rail flex flex-col items-center border-r border-line bg-card" style="grid-area: rail">
            <!-- Top of the rail: the active sandbox's identity chip — switch between the user's sandboxes (owned +
                 shared), add another, or manage access. -->
            <SandboxSwitcher />
            <!-- The other members connected to this sandbox right now — live from the daemon's /events roster. -->
            <PresenceAvatars :members="presenceOthers" direction="column" :size="28" />
            <span class="mb-1 icon-rail-divider h-px bg-line"></span>

            <!-- The navigation tiles, in bands (Work / Judge / Know — see RAIL_GROUPS) separated by the same
                 hairline the rail already uses for its other seams. A 44px column has no room for a heading, so
                 the gap between runs IS the heading; the mobile menu, which has the width, spells them out.
                 THIS is the one part of the rail that scrolls — see .icon-rail-nav.

                 The views (and the "+") all talk to the daemon, so they are inert while it is unreachable — the
                 gate in <main> is the only thing to see anyway. The switcher and account stay live. -->
            <div class="icon-rail-nav flex flex-col items-center overflow-y-auto overscroll-contain">
                <template v-for="(band, at) in tileBands" :key="band.group.id">
                    <span v-if="at > 0" class="my-1 icon-rail-divider h-px bg-line"></span>
                    <RouterLink
                        v-for="tile in band.items"
                        :key="tile.to"
                        :to="tile.to"
                        class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                        :class="{ 'pointer-events-none opacity-40': !reachable, 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                        :tabindex="reachable ? undefined : -1"
                        :aria-disabled="!reachable"
                        :aria-label="tileLabel(tile)"
                        v-tooltip.right="tileLabel(tile)"
                    >
                        <span v-if="tile.icon === undefined" class="text-sm font-semibold">{{ initialsOf(tile.label) }}</span>
                        <Icon v-else :name="tile.icon!" class="text-lg" />
                        <!-- One badge for every tile, core or extension — see AreaTile.badge. A `mark` replaces the
                             number outright rather than sitting beside it: the chip is four pixels of glance, and a
                             glyph AND a digit in it would be two claims competing for the same read. No tooltip of its
                             own either: it would nest inside the tile's and open a second box on top of it — its
                             sentence rides the tile instead (see tileLabel). -->
                        <span
                            v-if="tile.badge"
                            class="absolute right-0.5 top-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
                            :class="badgeClass(tile.badge)"
                        >
                            <Icon v-if="tile.badge.mark !== undefined" :name="tile.badge.mark as IconName" />
                            <template v-else>{{ badgeText(tile.badge) }}</template>
                        </span>
                    </RouterLink>
                </template>
            </div>

            <span class="my-1 icon-rail-divider h-px bg-line"></span>

            <!-- The VPN indicator: present ONLY while a tunnel is up, because that is a fact about the sandbox
                 the operator must be able to see from any view — while it is connected, the agent's traffic,
                 git and package installs leave through someone else's network. Links to the Status card that
                 owns the controls. -->
            <RouterLink
                v-if="connectedVpns.length > 0"
                to="/sandbox/status"
                class="icon-rail-tile flex items-center justify-center rounded-lg text-success transition-colors hover:bg-overlay"
                :class="{ 'pointer-events-none opacity-40': !reachable }"
                :tabindex="reachable ? undefined : -1"
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
                :class="{ 'pointer-events-none opacity-40': !reachable }"
                :tabindex="reachable ? undefined : -1"
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
                 navigation tile — they are AreaTiles, and one badge renderer is the point of that shape. -->
            <RouterLink
                v-for="tile in runtimeTiles"
                :key="tile.to"
                :to="tile.to"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
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
                 with the number of live sessions (shells, dev servers, agent shells, jobs — background
                 processes are excluded, they never idle). Inert while the daemon is unreachable, like the view
                 tiles: every session lives on that machine, so there is nothing to open without it. -->
            <button
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

            <!-- Add a capability (a repo / internal tool / external tool) — the /capabilities page; every "add"
                 is a write to the sandbox's deploy.config.ts or a clone into /work, never platform storage. -->
            <RouterLink
                to="/capabilities"
                class="icon-rail-tile flex items-center justify-center rounded-lg border border-dashed border-line text-muted transition-colors hover:border-line-strong hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'border-line-strong bg-overlay text-content': isNavActive('/capabilities') }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                aria-label="Add a capability"
                v-tooltip.right="'Add a capability'"
            >
                <Icon name="plus" class="text-lg" />
            </RouterLink>

            <!-- The account control: avatar → a rich popover (central account, sandbox workspace, theme, actions). -->
            <AccountPanel />
        </nav>

        <!-- The chat's place in the grid — a slot, not the panel. The panel is mounted above the router and
             teleported in here (shell/dockSlots.ts), so the same live DOM serves the column, the pop-out window
             and a route this shell doesn't cover; `display: contents` means this element is not in the layout
             at all and the panel itself is still the grid item. -->
        <div ref="chatDock" class="contents"></div>

        <main class="relative flex min-w-0 flex-col overflow-hidden" style="grid-area: workspace">
            <SandboxGate>
                <div class="min-h-0 flex-1 overflow-auto scrollbar-thin">
                    <RouterView />
                </div>
                <!-- …and the same for the ONE terminal panel — sandbox-global (shells + dev servers), persistent
                     across views. Its slot is INSIDE the gate, which is what keeps a docked terminal off screen
                     while the daemon is unreachable: the panel parks itself when its slot goes away, rather than
                     presenting dead shells. -->
                <div ref="terminalDock" class="contents"></div>
            </SandboxGate>
        </main>

        <!-- Quick Open (Ctrl/Cmd+P) file palette — a Dialog that portals to body, so it overlays the whole shell
             regardless of where it sits in the grid. -->
        <QuickOpen />
    </div>
</template>

<style scoped>
.shell {
    grid-template-columns: var(--icon-rail-width) minmax(0, 1fr) var(--chat-width, 22rem);
    /* One real row fills 100vh; a stray fixed-position overlay anchor landing in an implicit row would let 1fr
     * starve it to 0 and split the height (see CLAUDE.md post-mortem). Pin a single explicit row so none can. */
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: "rail workspace chat";
}

.icon-rail {
    gap: var(--icon-rail-gap);
    padding-block: var(--icon-rail-padding);
}

/* NOTHING IN THE RAIL MAY BE SQUASHED. A column flex item defaults to flex-shrink: 1, and .icon-rail-tile sets
 * `height`, not `min-height` — so a rail that outgrew the viewport did not overflow or scroll, it silently
 * compressed its tiles toward their content height. Measured before this rule, with 14 nav + 7 system tiles:
 * the 44px nav tiles rendered at 24px on an 800–945px viewport and 28px at 1080px, with no scrollbar and
 * nothing clipped — they simply stopped being squares and lost nearly half their hit target. The nav tiles took
 * all of it while the seven outside kept their size, because shrinkage is distributed by flex-basis and the nav
 * run is by far the largest item in the column: the more extensions registered a tile, the more the tiles paid
 * and the less anything else did. With the rule, 21/21 tiles hold 44px at every viewport and the nav scrolls
 * (9 nav tiles fit at 945px, 11 at 1080px). */
.icon-rail > *,
.icon-rail-tile,
.icon-rail-divider {
    flex-shrink: 0;
}

/* The one part that gives. The nav tiles are the run that grows without bound (one per extension activation), so
 * they are the run that scrolls — leaving the switcher above and the terminal / "+" / account below anchored
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
