import { ref, type Ref } from "vue";
import { createTerminalSession, disposeTerminalSession, mountTerminalSession, type TerminalSession } from "./terminalSession";

/* Multi-tab terminal state for the terminal panel (pages/TerminalPanel.vue): an instance (createTerminalTabs)
 * over ONE module-level session cache, so a session's xterm/socket/scrollback survives unmount, collapse, and
 * navigation — shells and dev-server terminals get identical live-tab semantics. The TerminalTabsSource
 * describes the tab set: how to list sessions, and how to create/kill them. Every tab is ×-closable; `kind`
 * only gates restart (shells only — restarting a dev-server tab is Start's job). */

export interface TerminalTab {
    readonly name: string;
    // Shown on the pill; absent ⇒ the pill shows its position index (numbered shells).
    readonly label?: string;
    // false dims the pill (an untracked session, e.g. a finished one-shot job); absent ⇒ always bright.
    readonly running?: boolean;
    // A user shell (numbered, restartable) vs a dev-server panel session (labeled, restarted via Start) vs an
    // AI-managed agent session (labeled, sparkles icon) the Claude agent's Bash commands run in vs a job
    // session (labeled) the daemon runs user-triggered flows in (capability adds, infra check).
    readonly kind: "shell" | "panel" | "agent" | "job";
}

export interface TerminalTabsSource {
    readonly list: () => Promise<TerminalTab[]>;
    readonly create?: () => string;
    readonly kill?: (name: string) => void;
}

// Sandbox switch: every cached socket points at the OLD daemon — drop them all; the panel relists against the
// new daemon on its next refresh.
export const disposeAllSessions = (): void => {
    for (const session of cache.values()) {
        disposeTerminalSession(session);
    }
    cache.clear();
};

// The shared session cache — one xterm + socket per tmux session name, owned by no surface. An entry is
// disposed only when its session deliberately ends (tab ×, restart, or the daemon's exit frame); a mere
// unmount detaches the DOM host and keeps streaming. A cached session's exit handler belongs to the instance
// that created it — if that instance is gone the handler still evicts the cache entry, and a later instance's
// tab list self-heals on its next refresh.
const cache = new Map<string, TerminalSession>();

export interface TerminalTabs {
    readonly order: Ref<TerminalTab[]>;
    readonly activeName: Ref<string | undefined>;
    readonly attach: (el: HTMLElement) => Promise<void>;
    readonly detach: () => void;
    readonly refresh: () => Promise<void>;
    // Focus a specific session, refreshing the list first when it isn't tabbed yet (a row's terminal button).
    readonly focus: (name: string) => Promise<void>;
    // Surface a session as a tab (relist until it appears) without mounting it — never steals the active tab.
    readonly surface: (name: string) => Promise<void>;
    readonly switchTab: (name: string) => void;
    // Inject input into the active session (the touch extra-keys row) — same path as a keystroke.
    readonly sendInput: (data: string) => void;
    readonly newTab?: () => void;
    readonly closeTab?: (name: string) => void;
    readonly restart?: () => void;
}

// One surface's tab state. `storageKey` namespaces the remembered active tab; `onEmpty` fires when the last
// tab ends (the panel closes itself).
export const createTerminalTabs = (source: TerminalTabsSource, storageKey: string, onEmpty: () => void): TerminalTabs => {
    const activeKey = `ui-${storageKey}-terminal-active`;
    const order = ref<TerminalTab[]>([]);
    const activeName = ref<string | undefined>(undefined);
    let container: HTMLElement | undefined;

    const sessionOf = (name: string): TerminalSession => {
        const cached = cache.get(name);
        if (cached !== undefined) {
            return cached;
        }
        const session = createTerminalSession(name, endSession);
        cache.set(name, session);
        return session;
    };

    // Mount one tab into the container: the shared core moves the persistent host across (xterm is open()ed
    // exactly once) and resyncs the PTY grid.
    const mount = (name: string | undefined): void => {
        if (name === undefined || container === undefined || !order.value.some((tab) => tab.name === name)) {
            return;
        }
        const previous = activeName.value !== undefined ? cache.get(activeName.value) : undefined;
        const session = sessionOf(name);
        if (previous !== undefined && previous !== session) {
            previous.host.remove();
        }
        mountTerminalSession(session, container);
        activeName.value = name;
        window.localStorage.setItem(activeKey, name);
    };

    // Re-list the surface's sessions. Every listed session connects immediately — a hidden tab still streams,
    // so switching to it is instant (tmux redraws at the fitted size).
    const refresh = async (): Promise<void> => {
        const tabs = await source.list();
        order.value = tabs;
        for (const tab of tabs) {
            sessionOf(tab.name);
        }
        if (activeName.value === undefined || !tabs.some((tab) => tab.name === activeName.value)) {
            const remembered = window.localStorage.getItem(activeKey) ?? undefined;
            mount(remembered !== undefined && tabs.some((tab) => tab.name === remembered) ? remembered : tabs[0]?.name);
        }
    };

    const attach = async (el: HTMLElement): Promise<void> => {
        container = el;
        await refresh();
        if (order.value.length === 0 && source.create !== undefined) {
            newTab();
        }
    };

    // Remove the mounted tab from the DOM without touching any session — sockets, xterms, scrollback stay alive.
    const detach = (): void => {
        if (activeName.value !== undefined) {
            cache.get(activeName.value)?.host.remove();
        }
    };

    // A session ended (tab ×, or the daemon's exit frame): dispose its client state, drop the tab, focus a
    // neighbour — or hand off to onEmpty when it was the last.
    const endSession = (name: string): void => {
        const session = cache.get(name);
        if (session !== undefined) {
            disposeTerminalSession(session);
            cache.delete(name);
        }
        const remaining = order.value.filter((tab) => tab.name !== name);
        order.value = remaining;
        if (activeName.value !== name) {
            return;
        }
        activeName.value = undefined;
        if (remaining.length === 0) {
            onEmpty();
            return;
        }
        mount(remaining[0]?.name);
    };

    const focus = async (name: string): Promise<void> => {
        if (!order.value.some((tab) => tab.name === name)) {
            await refresh();
        }
        mount(name);
    };

    // Make a session that just appeared (the agent's `agent-<id>` the moment it runs Bash) show up as a tab
    // WITHOUT mounting it — refresh() keeps the current active tab, so focus isn't stolen. Relist a few times to
    // cover tmux-run's session-create lag; a session that never materializes just stops after ~1s. The
    // common case (already listed) exits on the first check.
    const surface = async (name: string): Promise<void> => {
        for (let attempt = 0; attempt < 5 && !order.value.some((tab) => tab.name === name); attempt++) {
            await refresh();
            if (order.value.some((tab) => tab.name === name)) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    };

    const switchTab = (name: string): void => mount(name);

    // Programmatic input into the active session, routed through xterm's input handler (fires the same onData
    // that a keystroke does), so the touch extra-keys row reuses the existing socket wiring.
    const sendInput = (data: string): void => {
        const name = activeName.value;
        if (name !== undefined) {
            cache.get(name)?.term.input(data, true);
        }
    };

    if (source.create === undefined || source.kill === undefined) {
        return { order, activeName, attach, detach, refresh, focus, surface, switchTab, sendInput };
    }
    const create = source.create;
    const kill = source.kill;
    // Open a fresh tab and switch to it. Creation is implicit: opening the socket runs `tmux new-session -A`.
    const newTab = (): void => {
        const name = create();
        sessionOf(name);
        order.value = [...order.value, { name, kind: `shell` }];
        mount(name);
    };
    // Close a tab (its × button): kill the tmux session for good, then drop its client state.
    const closeTab = (name: string): void => {
        kill(name);
        endSession(name);
    };
    // Restart the active shell: kill its session and open a fresh tab in its place (auto-reconnect handles a
    // mere dropped socket, so this is for "give me a clean shell"). Always keeps the panel open.
    const restart = (): void => {
        const name = activeName.value;
        if (name === undefined) {
            return;
        }
        kill(name);
        const session = cache.get(name);
        if (session !== undefined) {
            disposeTerminalSession(session);
            cache.delete(name);
        }
        order.value = order.value.filter((tab) => tab.name !== name);
        activeName.value = undefined;
        newTab();
    };
    return { order, activeName, attach, detach, refresh, focus, surface, switchTab, sendInput, newTab, closeTab, restart };
};
