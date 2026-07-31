<script setup lang="ts">
import type { ViewBadge } from "@intentic/extension-api";
import type { IconName } from "@intentic-app/ui";
import { computed, onUnmounted, watch } from "vue";
import { RouterView, useRoute } from "vue-router";
import { useAgents } from "../composables/agents/useAgents";
import { useBrowsersQuery } from "../composables/browser/browsersQuery";
import { useSubagentsQuery } from "../composables/subagents/subagentsQuery";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useDrafts } from "../composables/extensions/useDrafts";
import { globalTerminalSource, useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { useTerminalActivity } from "../composables/terminal/useTerminalActivity";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";
import { commandShortcut } from "../composables/commands/useCommands";
import { type ActiveExtension, activationBadge, detectActivations, extensionPath } from "../core-views/registry";
import TerminalPanel from "../pages/TerminalPanel.vue";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useShellCommands } from "../composables/commands/useShellCommands";
import { useKeybindings } from "../composables/commands/useKeybindings";
import { useLayout } from "../composables/useLayout";
import { useIconRailSize } from "../composables/useIconRailSize";
import { usePanels } from "../composables/extensions/usePanels";
import { useChanges } from "../composables/workspace/useChanges";
import { usePorts } from "../composables/sandbox/usePorts";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useVpn } from "../composables/sandbox/useVpn";
import AccountPanel from "./AccountPanel.vue";
import ChatPanel from "../chat/ChatPanel.vue";
import PresenceStack from "../presence/PresenceStack.vue";
import QuickOpen from "./QuickOpen.vue";
import SandboxGate from "../sandbox-gates/SandboxGate.vue";
import SandboxSwitcher from "../sandbox-gates/SandboxSwitcher.vue";

interface AreaTile {
    // The route the tile links to (e.g. /workspace, /panel/app).
    readonly to: string;
    readonly label: string;
    // An `IconName` for the fixed areas; undefined for a repository tile, which renders its initials instead.
    readonly icon?: IconName;
    // What the tile says without being opened. The same shape core areas and extensions both fill, so the rail
    // renders ONE badge element instead of a hardcoded span per route.
    readonly badge?: ViewBadge;
}

// Badge tone → chip classes. `info` is the resting tone every core count has always used; `danger` is reserved
// for "broken", which is why nothing in the core shell claims it.
const BADGE_TONE: Record<NonNullable<ViewBadge["tone"]>, string> = {
    info: `bg-primary-600/15 text-link`,
    warning: `bg-warning/15 text-warning`,
    danger: `bg-danger/15 text-danger`,
};
const badgeClass = (badge: ViewBadge): string => BADGE_TONE[badge.tone ?? `info`];
const badgeText = (badge: ViewBadge): string => (badge.count > 99 ? `99+` : String(badge.count));

/* The desktop chrome of the post-login shell: a square-tile rail, the shared Claude Code chat panel, and a
 * workspace outlet for the active area. Layout is a three-column CSS grid; the chat width is driven by a
 * `--chat-width` CSS variable (useLayout), which the chat panel's drag handle updates. The shared (device-
 * independent) lifecycle — liveness, presence, plan — lives in WorkspaceShell, which picks this or ShellMobile. */

const { panels } = usePanels();
const { capabilities } = useCapabilities();
// Drafts is agent-driven and usually empty — its rail tile appears only once there's something to act on.
const { drafts, invalid: invalidDrafts } = useDrafts();
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
const { poppedOut, restoring: chatRestoring, body: chatPopoutBody, dock } = useChatPopout();
const route = useRoute();

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

// The thin shell: two always-present areas, then one tile per EXTENSION ACTIVATION — extensions detect
// workspace content (repo facts from /panels) and contribute their own sidebar elements (Infrastructure, Live
// status, one per monorepo, …) — then the "+" Capabilities tile (rendered separately below). The Sandbox
// status/management view lives behind the switcher chip, not a rail tile. The rail is capability-first: a repo
// no extension serves lives only in the Workspace file tree.
const fixedTiles = computed<readonly AreaTile[]>(() => [
    {
        to: `/agents`,
        label: `Agents`,
        icon: `comments`,
        ...(agentAttention.value > 0
            ? {
                  badge: {
                      count: agentAttention.value,
                      tooltip: `${agentAttention.value} agent${agentAttention.value === 1 ? `` : `s`} need${agentAttention.value === 1 ? `s` : ``} you`,
                  },
              }
            : {}),
    },
    {
        to: `/workspace`,
        label: `Workspace`,
        icon: `folder`,
        ...(changes.count.value > 0
            ? {
                  badge: {
                      count: changes.count.value,
                      tooltip: `${changes.count.value} uncommitted ${changes.count.value === 1 ? `change` : `changes`}`,
                  },
              }
            : {}),
    },
]);
// Slotted in between Agents and Workspace only when the agent has proposed a draft (or left an unreadable draft file) — an
// empty queue keeps the rail uncluttered, mirroring the extension tiles that appear on content. Drafts stays a
// core shell surface (the mobile bottom-bar "Review" tab depends on it too), so its tile is not an extension.
const draftsTile: AreaTile = { to: `/drafts`, label: `Drafts`, icon: `send` };
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
        to: `/browsers`,
        label: `Browsers`,
        icon: `desktop`,
        ...(live > 0 ? { badge: { count: live, tooltip: `${live} agent browser${live === 1 ? `` : `s`} open` } } : {}),
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
        to: `/subagents`,
        label: `Subagents`,
        icon: `users`,
        ...(live > 0 ? { badge: { count: live, tooltip: `${live} agent${live === 1 ? `` : `s`} working` } } : {}),
    };
});
// Activation.icon is an open string in the public extension API; the rail trusts it names one of the app's
// icons (an unknown name renders the icon set's fallback).
const extensionTile = (active: ActiveExtension): AreaTile => {
    const { extension, activation } = active;
    const badge = activationBadge(active);
    return {
        to: extensionPath(extension, activation),
        label: activation.title,
        ...(activation.icon === undefined ? {} : { icon: activation.icon as IconName }),
        ...(badge === undefined ? {} : { badge }),
    };
};
// The navigation tiles: the always-present areas, Drafts when there is something to review, then one tile per
// EXTENSION ACTIVATION (extensions detect workspace content from /panels and contribute their own areas). Live
// runtime surfaces (browsers, subagents, forwarded ports, the terminal) are NOT here — they render in the cluster
// below the divider, next to the "+" and account controls.
const tiles = computed<readonly AreaTile[]>(() => {
    const base = drafts.value.length > 0 || invalidDrafts.value.length > 0 ? fixedTiles.value.toSpliced(1, 0, draftsTile) : fixedTiles.value;
    return [
        ...base,
        ...detectActivations(panels.value, capabilities.value)
            // Only rail-surface extensions get a tile; per-repo directory panels (Apps, UI, preview) open from
            // the Workspace tree instead, so the rail stays a short, capability-first list.
            .filter(({ extension }) => extension.surface === `rail`)
            .map(extensionTile),
    ];
});

// Up to two initials from a repository name's word boundaries (my-shop-api → MS, api → AP) — the rail tile's
// glyph, so repositories stay distinguishable instead of all sharing one icon.
const initials = (name: string): string => {
    const parts = name.split(/[-_\s]+/).filter(Boolean);
    const raw =
        parts.length > 1
            ? parts
                  .slice(0, 2)
                  .map((part) => part[0])
                  .join("")
            : (parts[0] ?? name).slice(0, 2);
    return raw.toUpperCase();
};

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

// The global terminal panel: mounted here (below every view) because tmux sessions are sandbox-global facts —
// shells and dev servers stay visible while navigating. Ctrl+` toggles it from anywhere in the shell.
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
// Like the chat, the whole panel can float in its own window (right-click its tab strip) — teleported there,
// docked back on window close.
const { poppedOut: terminalPoppedOut, restoring: terminalRestoring, body: terminalPopoutBody, dock: dockTerminal } = useTerminalPopout();
// Closing the panel (its ×, Ctrl+`) while floating also retires the otherwise-empty pop-out window.
watch(terminal.open, (open) => {
    if (!open) {
        dockTerminal();
    }
});
// The core shell's built-in Command Palette commands (navigation, terminal, chat pop-out, Go to File / Command
// Palette) — registered on mount, disposed on unmount, so the `>` command mode is populated the moment the shell
// is up. Each carries its own `keybinding`, so it is reachable by both the palette and a shortcut.
useShellCommands();
// The single global-shortcut dispatcher: it runs whichever registered command's keybinding matches the keystroke
// (Ctrl+` → terminal, Mod+P → Go to File, Mod+Shift+P → Command Palette, plus any extension-contributed binding),
// replacing a bespoke per-shortcut hub. All actions are sandbox-global, so it lives at the shell, not in a view.
useKeybindings();

onUnmounted(() => {
    // Don't leave a floating chat or terminal window orphaned if the desktop chrome tears down (logout,
    // session loss, or the viewport crossing into the mobile shell).
    dock();
    dockTerminal();
});
</script>

<template>
    <div class="shell grid h-screen overflow-hidden bg-canvas text-content" :style="gridStyle">
        <nav class="icon-rail flex flex-col items-center border-r border-line bg-card" style="grid-area: rail">
            <!-- Top of the rail: the active sandbox's identity chip — switch between the user's sandboxes (owned +
                 shared), add another, or manage access. -->
            <SandboxSwitcher />
            <!-- The other members connected to this sandbox right now — live from the daemon's /events roster. -->
            <PresenceStack />
            <span class="mb-1 icon-rail-divider h-px bg-line"></span>

            <!-- The views (and the "+") all talk to the daemon, so they are inert while it is unreachable — the
                 gate in <main> is the only thing to see anyway. The switcher and account stay live. -->
            <RouterLink
                v-for="tile in tiles"
                :key="tile.to"
                :to="tile.to"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                :aria-label="tile.label"
                v-tooltip.right="tile.label"
            >
                <span v-if="tile.icon === undefined" class="text-sm font-semibold">{{ initials(tile.label) }}</span>
                <Icon v-else :name="tile.icon!" class="text-lg" />
                <!-- One badge for every tile, core or extension — see AreaTile.badge. -->
                <span
                    v-if="tile.badge"
                    class="absolute right-0.5 top-0.5 min-w-4 rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
                    :class="badgeClass(tile.badge)"
                    v-tooltip.right="tile.badge.tooltip"
                    >{{ badgeText(tile.badge) }}</span
                >
            </RouterLink>

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

            <!-- The agent's browsers: a live-runtime surface like the terminal, so it sits in this cluster
                 rather than with the navigation tiles above. Badged with the count of RUNNING sessions only
                 (see browserTile). -->
            <RouterLink
                v-if="browserTile"
                :to="browserTile.to"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'bg-primary-600/15 text-link': isNavActive(browserTile.to) }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                :aria-label="browserTile.label"
                v-tooltip.right="browserTile.label"
            >
                <Icon :name="browserTile.icon!" class="text-lg" />
                <span
                    v-if="browserTile.badge"
                    class="absolute right-0.5 top-0.5 min-w-4 rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
                    :class="badgeClass(browserTile.badge)"
                    v-tooltip.right="browserTile.badge.tooltip"
                    >{{ badgeText(browserTile.badge) }}</span
                >
            </RouterLink>

            <!-- The agent's subagents, beside its browsers because they are the same kind of thing: work a turn
                 spawned, watchable while it runs. Badged with the count still WORKING (see subagentTile). -->
            <RouterLink
                v-if="subagentTile"
                :to="subagentTile.to"
                class="icon-rail-tile relative flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'bg-primary-600/15 text-link': isNavActive(subagentTile.to) }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                :aria-label="subagentTile.label"
                v-tooltip.right="subagentTile.label"
            >
                <Icon :name="subagentTile.icon!" class="text-lg" />
                <span
                    v-if="subagentTile.badge"
                    class="absolute right-0.5 top-0.5 min-w-4 rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
                    :class="badgeClass(subagentTile.badge)"
                    v-tooltip.right="subagentTile.badge.tooltip"
                    >{{ badgeText(subagentTile.badge) }}</span
                >
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

        <!-- Docked in the grid's chat column, or teleported into the pop-out window — same live DOM either way,
             so the useChat singleton and the streaming turn are untouched by the move. Held back entirely while
             a pop-out window from before a reload is still coming back, so the panel mounts once, out there,
             instead of building itself in the collapsed column first. -->
        <Teleport :to="chatPopoutBody" :disabled="!poppedOut">
            <ChatPanel v-if="!chatRestoring" class="border-l border-line" style="grid-area: chat" />
        </Teleport>

        <main class="relative flex min-w-0 flex-col overflow-hidden" style="grid-area: workspace">
            <SandboxGate>
                <div class="min-h-0 flex-1 overflow-auto scrollbar-thin">
                    <RouterView />
                </div>
                <!-- The ONE terminal panel — sandbox-global (shells + dev servers), persistent across views.
                     Docked below the workspace, or teleported into its own window when popped out — same live
                     DOM either way, so the session cache and running shells are untouched by the move (the
                     panel fills the floating window, hence resizable off there). -->
                <Teleport :to="terminalPopoutBody" :disabled="!terminalPoppedOut">
                    <TerminalPanel
                        v-if="terminal.open.value && !terminalRestoring"
                        :source="globalTerminalSource"
                        storage-key="sandbox"
                        :initial="terminal.requested.value"
                        :surfaced="terminal.surfaced.value"
                        :resizable="!terminalPoppedOut"
                        @close="terminal.setOpen(false)"
                    />
                </Teleport>
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

.icon-rail-tile {
    width: var(--icon-rail-tile-size);
    height: var(--icon-rail-tile-size);
}

.icon-rail-divider {
    width: var(--icon-rail-divider-width);
}
</style>
