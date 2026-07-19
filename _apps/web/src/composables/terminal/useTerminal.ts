import { ref, type Ref, watch } from "vue";
import { createTerminalSession, disposeTerminalSession, mountTerminalSession, persistScrollback, type TerminalSession } from "./terminalSession";

/* Multi-tab terminal state for the terminal panel (pages/TerminalPanel.vue): an instance (createTerminalTabs)
 * over ONE module-level session cache, so a session's xterm/socket/scrollback survives unmount, collapse, and
 * navigation — shells and dev-server terminals get identical live-tab semantics. The TerminalTabsSource
 * describes the tab set: how to list sessions, and how to create/kill them. `kind` gates restart (shells
 * only — restarting a dev-server tab is Start's job) and the background-process split: "process" sessions
 * never tab by themselves — they live in `processes` (the popover's list) and tab only as read-only log
 * views via viewProcess, whose × merely hides them (killing a background process is the popover's explicit
 * Stop, never a tab close). */

export interface TerminalTab {
    readonly name: string;
    // Shown on the pill; absent ⇒ the pill shows its position index (numbered shells).
    readonly label?: string;
    // false dims the pill (an untracked session, e.g. a finished one-shot job); absent ⇒ always bright.
    readonly running?: boolean;
    // A user shell (numbered, restartable) vs a dev-server panel session (labeled, restarted via Start) vs an
    // AI-managed agent session (labeled, sparkles icon) the Claude agent's Bash commands run in vs a job
    // session (labeled) the daemon runs user-triggered flows in (capability adds, infra check) vs a managed
    // background process (an extension's declared processes, dockerd — read-only log views).
    readonly kind: "shell" | "panel" | "agent" | "job" | "process";
    // A process row that maps to an installed extension's declared process — the address for its
    // /extensions start/stop routes (absent on docker and orphaned sessions).
    readonly extensionId?: string;
    readonly processName?: string;
}

export interface TerminalTabsSource {
    readonly list: () => Promise<TerminalTab[]>;
    readonly create?: () => string;
    readonly kill?: (name: string) => void;
}

// Sandbox switch: every cached socket points at the OLD daemon — drop them all and bump the epoch so a
// mounted surface resets its tab state and relists against the new daemon.
export const disposeAllSessions = (): void => {
    for (const session of cache.values()) {
        disposeTerminalSession(session);
    }
    cache.clear();
    epoch.value += 1;
};

// The shared session cache — one xterm + socket per tmux session name, owned by no surface. An entry is
// disposed only when its session deliberately ends (tab ×, restart, or the daemon's exit frame); a mere
// unmount detaches the DOM host and keeps streaming. sessionOf rebinds a cached session's exit handler to
// the instance that touched it last, so an exit always updates a LIVE surface's tab state.
const cache = new Map<string, TerminalSession>();

// Bumped whenever the cache is wiped wholesale (sandbox switch) — mounted surfaces watch it.
const epoch = ref(0);

// Snapshot every live session's scrollback on reload/navigation — createTerminalSession restores it.
window.addEventListener(`pagehide`, () => {
    for (const session of cache.values()) {
        persistScrollback(session);
    }
});

export interface TerminalTabs {
    readonly order: Ref<TerminalTab[]>;
    // The managed background processes ("process" kind) from the last list — the processes popover's rows.
    readonly processes: Ref<TerminalTab[]>;
    readonly activeName: Ref<string | undefined>;
    readonly attach: (el: HTMLElement) => Promise<void>;
    readonly detach: () => void;
    readonly refresh: () => Promise<void>;
    // Focus a specific session, refreshing the list first when it isn't tabbed yet (a row's terminal button).
    readonly focus: (name: string) => Promise<void>;
    // Surface a session as a tab (relist until it appears) without mounting it — never steals the active tab.
    readonly surface: (name: string) => Promise<void>;
    // Open (and focus) a background process's read-only log view as a tab.
    readonly viewProcess: (name: string) => Promise<void>;
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
    const processes = ref<TerminalTab[]>([]);
    // Process sessions the user opened a log view for — the only "process" sessions that appear in `order`.
    const viewedProcesses = new Set<string>();
    const activeName = ref<string | undefined>(undefined);
    let container: HTMLElement | undefined;

    const sessionOf = (name: string, readOnly = false): TerminalSession => {
        const cached = cache.get(name);
        if (cached !== undefined) {
            // Sessions outlive the instance that created them (the panel remounts across v-if / mobile route) —
            // rebind so this instance's tab list is the one an exit frame updates.
            cached.onExit = endSession;
            return cached;
        }
        const session = createTerminalSession(name, endSession, readOnly);
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

    // Re-list the surface's sessions. Every tabbed session connects immediately — a hidden tab still streams,
    // so switching to it is instant (tmux redraws at the fitted size). Background processes stay out of the
    // tab set (and hold no idle sockets) until a log view is opened for them.
    const refresh = async (): Promise<void> => {
        const listed = await source.list();
        processes.value = listed.filter((tab) => tab.kind === `process`);
        const tabs = listed.filter((tab) => tab.kind !== `process` || viewedProcesses.has(tab.name));
        order.value = tabs;
        for (const tab of tabs) {
            sessionOf(tab.name, tab.kind === `process`);
        }
        if (activeName.value === undefined || !tabs.some((tab) => tab.name === activeName.value)) {
            const remembered = window.localStorage.getItem(activeKey) ?? undefined;
            mount(remembered !== undefined && tabs.some((tab) => tab.name === remembered) ? remembered : tabs[0]?.name);
        }
    };

    // Sandbox switch while mounted: the sessions are already disposed — drop the stale tab state and relist
    // against the new daemon. (createTerminalTabs runs in component setup, so the watcher dies with the surface.)
    watch(epoch, () => {
        order.value = [];
        processes.value = [];
        viewedProcesses.clear();
        activeName.value = undefined;
        void refresh();
    });

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
        viewedProcesses.delete(name);
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

    // Open a background process's read-only log view as a tab and focus it (the processes popover's View logs).
    const viewProcess = async (name: string): Promise<void> => {
        viewedProcesses.add(name);
        await refresh();
        mount(name);
    };

    const focus = async (name: string): Promise<void> => {
        if (!order.value.some((tab) => tab.name === name)) {
            await refresh();
        }
        // A background-process session never tabs directly — route it through its read-only log view
        // (`panel-docker`, an extension's gateway).
        if (processes.value.some((process) => process.name === name)) {
            await viewProcess(name);
            return;
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
        return { order, processes, activeName, attach, detach, refresh, focus, surface, viewProcess, switchTab, sendInput };
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
    // Close a tab (its × button): kill the tmux session for good, then drop its client state. A process log
    // view only hides — stopping a background process is the popover's explicit Stop, never a tab close.
    const closeTab = (name: string): void => {
        if (!viewedProcesses.has(name)) {
            kill(name);
        }
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
    return { order, processes, activeName, attach, detach, refresh, focus, surface, viewProcess, switchTab, sendInput, newTab, closeTab, restart };
};
