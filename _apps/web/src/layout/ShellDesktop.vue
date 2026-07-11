<script setup lang="ts">
import type { IconName } from "@intentic-app/ui";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterView, useRoute } from "vue-router";
import { useCapabilities } from "../composables/extensions/useCapabilities";
import { useDrafts } from "../composables/extensions/useDrafts";
import { globalTerminalSource, useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { detectActivations } from "../extensions";
import TerminalPanel from "../pages/TerminalPanel.vue";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useLayout } from "../composables/useLayout";
import { usePanels } from "../composables/extensions/usePanels";
import { useQuickOpen } from "../composables/useQuickOpen";
import { useReview } from "../composables/workspace/useReview";
import { useSandbox } from "../composables/useSandbox";
import AccountPanel from "./AccountPanel.vue";
import ChatPanel from "./ChatPanel.vue";
import PresenceStack from "./PresenceStack.vue";
import QuickOpen from "./QuickOpen.vue";
import SandboxGate from "./SandboxGate.vue";
import SandboxSwitcher from "./SandboxSwitcher.vue";

interface AreaTile {
    // The route the tile links to (e.g. /workspace, /panel/app).
    readonly to: string;
    readonly label: string;
    // An `IconName` for the fixed areas; undefined for a repository tile, which renders its initials instead.
    readonly icon?: IconName;
}

/* The desktop chrome of the post-login shell: a square-tile rail, the shared Claude Code chat panel, and a
 * workspace outlet for the active area. Layout is a three-column CSS grid; the chat width is driven by a
 * `--chat-width` CSS variable (useLayout), which the chat panel's drag handle updates. The shared (device-
 * independent) lifecycle — liveness, presence, plan — lives in WorkspaceShell, which picks this or ShellMobile. */

const { panels } = usePanels();
const { capabilities } = useCapabilities();
// Drafts is agent-driven and usually empty — its rail tile appears only once there's something to act on.
const { drafts, invalid: invalidDrafts } = useDrafts();
const { reachable } = useSandbox();
// Unreviewed agent changes surface as a count badge on the Workspace rail tile, visible from any area.
const review = useReview();
const layout = useLayout();
const { poppedOut, pipBody, dock } = useChatPopout();
const route = useRoute();

// A rail link is active for its route AND any sub-path — `active-class` can't do this: with a splat/optional
// param (workspace/:path, capabilities/:card) it compares params and drops the highlight the moment one is set
// (a file open on /workspace, a card open on /capabilities). Prefix match, harmless for the param-less tiles.
const isNavActive = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);

// The thin shell: two always-present areas, then one tile per EXTENSION ACTIVATION — extensions detect
// workspace content (repo facts from /panels) and contribute their own sidebar elements (Infrastructure, Live
// status, one per monorepo, …) — then the "+" Capabilities tile (rendered separately below). The Sandbox
// status/management view lives behind the switcher chip, not a rail tile. The rail is capability-first: a repo
// no extension serves lives only in the Workspace file tree.
const fixedTiles: readonly AreaTile[] = [
    { to: `/workspace`, label: `Workspace`, icon: `folder` },
    { to: `/automations`, label: `Automations`, icon: `clock` },
    { to: `/secrets`, label: `Secrets`, icon: `key` },
];
// Slotted in after Automations only when the agent has proposed a draft (or left an unreadable draft file) — an
// empty queue keeps the rail uncluttered, mirroring the extension tiles that appear on content.
const draftsTile: AreaTile = { to: `/drafts`, label: `Drafts`, icon: `send` };
const tiles = computed<readonly AreaTile[]>(() => {
    const base = drafts.value.length > 0 || invalidDrafts.value.length > 0 ? fixedTiles.toSpliced(2, 0, draftsTile) : fixedTiles;
    return [
        ...base,
        ...detectActivations(panels.value, capabilities.value)
            // Only rail-surface extensions get a tile; per-repo directory panels (Apps, UI, preview) open from
            // the Workspace tree instead, so the rail stays a short, capability-first list.
            .filter(({ extension }) => extension.surface === `rail`)
            .map(({ extension, activation }): AreaTile => {
                const to = `/ext/${extension.id}/${encodeURIComponent(activation.key)}`;
                return activation.icon === undefined ? { to, label: activation.title } : { to, label: activation.title, icon: activation.icon };
            }),
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

// Collapse the chat column to nothing while the panel is popped out (it's teleported into the pip window), so
// the workspace reclaims the full width.
const gridStyle = computed(() => ({ "--chat-width": poppedOut.value ? `0px` : `${layout.chatWidth.value}px` }));

// The global terminal panel: mounted here (below every view) because tmux sessions are sandbox-global facts —
// shells and dev servers stay visible while navigating. Ctrl+` toggles it from anywhere in the shell.
const terminal = useTerminalPanel();
const terminalMaximized = ref(false);
const { isOpen: quickOpen } = useQuickOpen();
// The desktop shell's single global-shortcut hub (both actions are sandbox-global, so they live here rather than
// in any one view): Ctrl+` toggles the terminal, Ctrl/Cmd+P opens the Quick Open file palette.
const onShellKey = (event: KeyboardEvent): void => {
    if (event.ctrlKey && event.key === `\``) {
        event.preventDefault();
        terminal.toggle();
        return;
    }
    // VSCode Ctrl/Cmd+P — !shift keeps Ctrl+Shift+P free; preventDefault overrides the browser's print dialog.
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === `p`) {
        event.preventDefault();
        quickOpen.value = true;
    }
};

onMounted(() => {
    window.addEventListener(`keydown`, onShellKey);
});
onUnmounted(() => {
    window.removeEventListener(`keydown`, onShellKey);
    // Don't leave a floating chat window orphaned if the desktop chrome tears down (logout, session loss, or
    // the viewport crossing into the mobile shell).
    dock();
});
</script>

<template>
    <div class="shell grid h-screen overflow-hidden bg-canvas text-content" :style="gridStyle">
        <nav class="flex flex-col items-center gap-2 border-r border-line bg-card py-3" style="grid-area: rail">
            <!-- Top of the rail: the active sandbox's identity chip — switch between the user's sandboxes (owned +
                 shared), add another, or manage access. -->
            <SandboxSwitcher />
            <!-- The other members connected to this sandbox right now — live from the daemon's /events roster. -->
            <PresenceStack />
            <span class="mb-1 h-px w-8 bg-line"></span>

            <!-- The views (and the "+") all talk to the daemon, so they are inert while it is unreachable — the
                 gate in <main> is the only thing to see anyway. The switcher and account stay live. -->
            <RouterLink
                v-for="tile in tiles"
                :key="tile.to"
                :to="tile.to"
                class="relative flex h-11 w-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'bg-primary-600/15 text-link': isNavActive(tile.to) }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                :aria-label="tile.label"
                v-tooltip.right="tile.label"
            >
                <span v-if="tile.icon === undefined" class="text-sm font-semibold">{{ initials(tile.label) }}</span>
                <Icon v-else :name="tile.icon!" class="text-lg" />
                <span
                    v-if="tile.to === '/workspace' && review.count.value > 0"
                    class="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary-600/15 px-1 text-center text-[0.6rem] font-semibold leading-4 text-link"
                    v-tooltip.right="`${review.count.value} unreviewed agent ${review.count.value === 1 ? 'change' : 'changes'}`"
                    >{{ review.count.value > 99 ? "99+" : review.count.value }}</span
                >
            </RouterLink>

            <span class="my-1 h-px w-8 bg-line"></span>

            <!-- Add a capability (a repo / internal tool / external tool) — the /capabilities page; every "add"
                 is a write to the sandbox's deploy.config.ts or a clone into /work, never platform storage. -->
            <RouterLink
                to="/capabilities"
                class="flex h-11 w-11 items-center justify-center rounded-lg border border-dashed border-line text-muted transition-colors hover:border-line-strong hover:bg-overlay hover:text-content"
                :class="{ 'pointer-events-none opacity-40': !reachable, 'border-line-strong bg-overlay text-content': isNavActive('/capabilities') }"
                :tabindex="reachable ? undefined : -1"
                :aria-disabled="!reachable"
                aria-label="Add a capability"
                v-tooltip.right="'Add a capability'"
            >
                <Icon name="plus" class="text-lg" />
            </RouterLink>

            <!-- Return the popped-out chat to its docked column (only while it floats in a separate window). -->
            <button
                v-if="poppedOut"
                type="button"
                class="flex h-11 w-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="dock"
                aria-label="Return chat"
                v-tooltip.right="'Return chat'"
            >
                <Icon name="window-minimize" class="text-lg" />
            </button>

            <!-- The account control: avatar → a rich popover (central account, sandbox workspace, theme, actions). -->
            <AccountPanel />
        </nav>

        <!-- Docked in the grid's chat column, or teleported into the pip window when popped out — same live DOM
             either way, so the useChat singleton and the streaming turn are untouched by the move. -->
        <Teleport :to="pipBody" :disabled="!poppedOut">
            <ChatPanel class="border-l border-line" style="grid-area: chat" />
        </Teleport>

        <main class="relative flex min-w-0 flex-col overflow-hidden" style="grid-area: workspace">
            <SandboxGate>
                <div class="min-h-0 flex-1 overflow-auto scrollbar-thin" :class="{ hidden: terminalMaximized }">
                    <RouterView />
                </div>
                <!-- The ONE terminal panel — sandbox-global (shells + dev servers), persistent across views. -->
                <TerminalPanel
                    v-if="terminal.open.value"
                    v-model:maximized="terminalMaximized"
                    :source="globalTerminalSource"
                    storage-key="sandbox"
                    :initial="terminal.requested.value"
                    :surfaced="terminal.surfaced.value"
                    @close="terminal.setOpen(false)"
                />
            </SandboxGate>
        </main>

        <!-- Quick Open (Ctrl/Cmd+P) file palette — a Dialog that portals to body, so it overlays the whole shell
             regardless of where it sits in the grid. -->
        <QuickOpen />
    </div>
</template>

<style scoped>
.shell {
    grid-template-columns: 4rem minmax(0, 1fr) var(--chat-width, 22rem);
    /* One real row fills 100vh; an unplaced overlay anchor (e.g. GoogleSigninGate) lands in an implicit row,
     * which 1fr starves to 0 so it can't split the height (see CLAUDE.md post-mortem). */
    grid-template-rows: minmax(0, 1fr);
    grid-template-areas: "rail workspace chat";
}
</style>
