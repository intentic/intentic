import { ref, type Ref, watch } from "vue";
import { showAgentTerminals } from "./useAgentTerminals";
import { addPendingTerminal, dropPendingTerminal } from "./terminalsQuery";
import { pruneTerminalMeta } from "./terminalMeta";
import {
    createTerminalSession,
    disposeTerminalSession,
    mountTerminalSession,
    parkTerminalSession,
    persistScrollback,
    type TerminalSession,
} from "./terminalSession";

/* Multi-tab terminal state for the terminal panel (pages/TerminalPanel.vue): an instance (createTerminalTabs)
 * over ONE module-level session cache, so a session's xterm/socket/scrollback survives unmount, collapse, and
 * navigation — shells and dev-server terminals get identical live-tab semantics. The TerminalTabsSource
 * describes the tab set: how to list sessions, and how to create/kill them. `kind` gates restart (shells
 * only — restarting a dev-server tab is Start's job) and the background-process split: "process" sessions
 * never tab by themselves — they live in `processes` (the popover's list) and tab only as read-only log
 * views via viewProcess, whose × merely hides them (killing a background process is the popover's explicit
 * Stop, never a tab close). "agent" sessions follow the same shape for a different reason: an agent's shell is
 * evidence about a turn rather than a tab the user keeps, so unless `showAgentTerminals` is on it tabs only
 * once explicitly opened (the chat's Bash card, the AI-terminals popover) — see useAgentTerminals.
 *
 * Tabs arrange into GROUPS (VSCode's split terminals): `groups` is the strip order, each entry an ordered
 * list of session names rendered side by side in one pane when active. Grouping is pure client view state
 * (tmux sees flat sessions), persisted per storageKey; the daemon's list stays the truth for which sessions
 * exist — reconcile drops dead names and appends newcomers as their own single-tab groups. */

export interface TerminalTab {
    readonly name: string;
    // Shown on the pill; absent ⇒ the pill shows its position index (numbered shells).
    readonly label?: string;
    // false dims the pill (an untracked session, e.g. a finished one-shot job) and offers it to the sweep.
    // Required, like the daemon's own field: a tab whose liveness is merely unknown has never existed.
    readonly running: boolean;
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
    // Resolves once the daemon has answered and the source has settled the shared session list against that
    // answer — which is the only reason it is async at all. The tab is gone from the strip long before then
    // (endSession is synchronous), so nothing awaits it for the view; callers `void` it. NEVER rejects, for
    // that same reason: a kill that failed is the source's to reconcile and report, and a promise nobody
    // awaits is the one place a throw goes nowhere.
    readonly kill?: (name: string) => Promise<void>;
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
    // The strip: ordered groups of session names; a group of one is a plain tab, more are split side by side.
    readonly groups: Ref<string[][]>;
    // The managed background processes ("process" kind) from the last list — the processes popover's rows.
    readonly processes: Ref<TerminalTab[]>;
    // The FOCUSED session — keystrokes land here; its group is the mounted pane.
    readonly activeName: Ref<string | undefined>;
    // Resolves true when attaching auto-created the first shell (an empty managed panel opens with one).
    readonly attach: (el: HTMLElement) => Promise<boolean>;
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
    // Merge the named sessions (strip order) into one split group at the first one's position.
    readonly joinTabs: (names: string[]) => void;
    // Move one session out of its split group into its own tab, right after the group.
    readonly unsplit: (name: string) => void;
    readonly newTab?: () => void;
    readonly closeTab?: (name: string) => void;
    // Open a fresh shell INSIDE the named session's group, splitting the pane (VSCode's Split Terminal).
    readonly splitTab?: (name: string) => void;
    // Kill several sessions at once (the strip's multi-selection).
    readonly killTabs?: (names: string[]) => void;
    readonly restart?: () => void;
}

// One surface's tab state. `storageKey` namespaces the remembered active tab + grouping; `onEmpty` fires when
// the last tab ends (the panel closes itself).
export const createTerminalTabs = (source: TerminalTabsSource, storageKey: string, onEmpty: () => void): TerminalTabs => {
    const activeKey = `ui-${storageKey}-terminal-active`;
    const groupsKey = `ui-${storageKey}-terminal-groups`;
    const order = ref<TerminalTab[]>([]);
    const processes = ref<TerminalTab[]>([]);
    // Process sessions the user opened a log view for — the only "process" sessions that appear in `order`.
    const viewedProcesses = new Set<string>();
    // Agent sessions revealed by an explicit open while the preference is off. Held for this surface's lifetime
    // only, exactly like `viewedProcesses`: a reveal is "show me this now", so it must not outlive the panel or
    // need pruning once the session is gone.
    const revealedAgents = new Set<string>();
    const activeName = ref<string | undefined>(undefined);
    let container: HTMLElement | undefined;
    // The session names whose hosts are currently in the container — the active group's members.
    let mountedNames: string[] = [];

    const readGroups = (): string[][] => {
        try {
            const parsed: unknown = JSON.parse(window.localStorage.getItem(groupsKey) ?? `[]`);
            if (Array.isArray(parsed)) {
                return parsed.filter((group): group is string[] => Array.isArray(group) && group.every((name) => typeof name === `string`));
            }
        } catch {
            // fall through to empty
        }
        return [];
    };
    const groups = ref<string[][]>(readGroups());
    const persistGroups = (): void => {
        try {
            window.localStorage.setItem(groupsKey, JSON.stringify(groups.value));
        } catch {
            // Storage may be unavailable (private mode); the in-memory ref still holds.
        }
    };

    const groupOf = (name: string): string[] => groups.value.find((group) => group.includes(name)) ?? [name];

    // The two kinds that are listed by the daemon but do not tab on their own: a background process (its
    // lifecycle belongs to the processes popover) and — unless the user asked for them — the agent's shells.
    // Both become tabs the moment they are explicitly opened, and only then.
    const hiddenFromStrip = (tab: TerminalTab): boolean => {
        if (tab.kind === `process`) {
            return !viewedProcesses.has(tab.name);
        }
        return tab.kind === `agent` && !showAgentTerminals.value && !revealedAgents.has(tab.name);
    };

    const sessionOf = (name: string, readOnly = false): TerminalSession => {
        const cached = cache.get(name);
        if (cached !== undefined) {
            // Sessions outlive the instance that created them (the panel remounts across v-if / mobile route) —
            // rebind so this instance's tab list is the one an exit frame updates.
            cached.onExit = endSession;
            return cached;
        }
        // The container sizes the PTY at birth (even for a tab that stays hidden — it would mount here).
        const session = createTerminalSession(name, endSession, readOnly, container);
        cache.set(name, session);
        return session;
    };

    // Mount `name`'s whole group into the container — one flex cell per member, side by side — and focus
    // `name`. The shared core moves each persistent host across (xterm is open()ed exactly once) and resyncs
    // its PTY grid; a focusin on any cell (clicking into a split) retargets keystroke routing and the strip
    // highlight without remounting.
    const mount = (name: string | undefined): void => {
        if (name === undefined || container === undefined || !order.value.some((tab) => tab.name === name)) {
            return;
        }
        const tabbed = new Set(order.value.map((tab) => tab.name));
        const group = groupOf(name).filter((member) => tabbed.has(member));
        for (const mounted of mountedNames) {
            const session = cache.get(mounted);
            if (session !== undefined) {
                parkTerminalSession(session);
            }
        }
        container.replaceChildren();
        container.classList.toggle(`term-split`, group.length > 1);
        for (const member of group) {
            const cell = document.createElement(`div`);
            cell.className = `term-cell`;
            cell.addEventListener(`focusin`, () => {
                activeName.value = member;
                window.localStorage.setItem(activeKey, member);
            });
            container.append(cell);
            mountTerminalSession(sessionOf(member), cell, member === name);
        }
        mountedNames = group;
        activeName.value = name;
        window.localStorage.setItem(activeKey, name);
    };

    // Reconcile the persisted grouping against the listed tabs: dead names drop out, empty groups collapse,
    // and every newly-listed session gets its own single-tab group at the end of the strip.
    const reconcileGroups = (tabs: TerminalTab[]): void => {
        const tabbed = new Set(tabs.map((tab) => tab.name));
        const kept = groups.value.map((group) => group.filter((name) => tabbed.has(name))).filter((group) => group.length > 0);
        const grouped = new Set(kept.flat());
        for (const tab of tabs) {
            if (!grouped.has(tab.name)) {
                kept.push([tab.name]);
            }
        }
        groups.value = kept;
        persistGroups();
    };

    // Re-list the surface's sessions. Every tabbed session connects immediately — a hidden tab still streams,
    // so switching to it is instant (tmux redraws at the fitted size). Background processes stay out of the
    // tab set (and hold no idle sockets) until a log view is opened for them.
    //
    // `container` is the liveness gate, checked on BOTH sides of the await: detach() clears it, so a list still
    // in flight when the panel tears down (a fast Ctrl+` off/on) can't write this dead instance's grouping back
    // to localStorage, and — via mount() — can't append a session's host into a detached container, which would
    // STEAL it from the instance that replaced us and leave the live panel a blank pane.
    const refresh = async (): Promise<void> => {
        if (container === undefined) {
            return;
        }
        const listed = await source.list();
        if (container === undefined) {
            return;
        }
        pruneTerminalMeta(new Set(listed.map((tab) => tab.name)));
        processes.value = listed.filter((tab) => tab.kind === `process`);
        const tabs = listed.filter((tab) => !hiddenFromStrip(tab));
        order.value = tabs;
        reconcileGroups(tabs);
        for (const tab of tabs) {
            sessionOf(tab.name, tab.kind === `process`);
        }
        const tabbed = new Set(tabs.map((tab) => tab.name));
        if (activeName.value === undefined || !tabbed.has(activeName.value)) {
            const remembered = window.localStorage.getItem(activeKey) ?? undefined;
            mount(remembered !== undefined && tabbed.has(remembered) ? remembered : tabs[0]?.name);
        } else if (mountedNames.some((name) => !tabbed.has(name))) {
            // The focused session survived but a groupmate vanished from the list (killed elsewhere) — remount
            // the shrunken group so its host doesn't linger.
            mount(activeName.value);
        }
    };

    // Sandbox switch while mounted: the sessions are already disposed — drop the stale tab state and relist
    // against the new daemon. (createTerminalTabs runs in component setup, so the watcher dies with the surface.)
    watch(epoch, () => {
        order.value = [];
        processes.value = [];
        groups.value = [];
        viewedProcesses.clear();
        activeName.value = undefined;
        mountedNames = [];
        void refresh();
    });

    // The preference toggled while the panel is open (the bar menu, the palette, the Settings row): relist, so
    // the agent's shells arrive as tabs — or leave — under the hand that just asked for it. Turning it off drops
    // them from `order` and `groups`; refresh() re-mounts around the survivors if the focused tab was one of
    // them, and their sockets stay parked in the cache in case the user flips back.
    watch(showAgentTerminals, () => {
        void refresh().then(() => {
            // Hiding the last tab would leave the panel around a blank pane (only endSession retires it), which
            // is the one case where the strip can empty without a session ending — so it opens a shell instead,
            // the same thing attach() does for an empty panel.
            if (order.value.length === 0 && source.create !== undefined) {
                newTab();
            }
        });
    });

    const attach = async (el: HTMLElement): Promise<boolean> => {
        container = el;
        await refresh();
        // Torn down (or re-attached) while the list was in flight — spawning the empty panel's opening shell
        // here would leave a real tmux session nobody asked for and nothing shows, which is how a rapid Ctrl+`
        // used to silt the sandbox up with orphan `web-*` shells.
        if (container !== el) {
            return false;
        }
        if (order.value.length === 0 && source.create !== undefined) {
            newTab();
            return true;
        }
        return false;
    };

    // Remove the mounted hosts from the DOM without touching any session — sockets, xterms, scrollback stay
    // alive. (The cell wrappers die with the panel's own DOM.) Dropping `container` is what retires this
    // instance: detach is only ever the unmount, and every async path re-checks it before touching the DOM.
    const detach = (): void => {
        for (const mounted of mountedNames) {
            const session = cache.get(mounted);
            if (session !== undefined) {
                parkTerminalSession(session);
            }
        }
        mountedNames = [];
        container = undefined;
    };

    // A session ended (tab ×, or the daemon's exit frame): dispose its client state, drop the tab, focus a
    // neighbour — its own group's survivor first — or hand off to onEmpty when it was the last.
    const endSession = (name: string): void => {
        viewedProcesses.delete(name);
        revealedAgents.delete(name);
        // Whether or not the daemon ever listed it, this name is spent — a claim left standing would keep the
        // session in the shared list (and in the rail's count) until the page reloaded.
        dropPendingTerminal(name);
        const session = cache.get(name);
        if (session !== undefined) {
            disposeTerminalSession(session);
            cache.delete(name);
        }
        const group = groups.value.find((members) => members.includes(name));
        groups.value = groups.value.map((members) => members.filter((member) => member !== name)).filter((members) => members.length > 0);
        persistGroups();
        const remaining = order.value.filter((tab) => tab.name !== name);
        order.value = remaining;
        // An empty strip retires the panel however the last tab went — ahead of the mounted check, which only
        // decides whether anything needs REmounting. (A last tab that was never mounted — the panel closed
        // before its list landed — used to leave the panel open around nothing.)
        if (remaining.length === 0) {
            mountedNames = [];
            activeName.value = undefined;
            onEmpty();
            return;
        }
        if (!mountedNames.includes(name)) {
            return;
        }
        mountedNames = mountedNames.filter((member) => member !== name);
        if (activeName.value === name || activeName.value === undefined) {
            activeName.value = undefined;
            const survivor = group?.find((member) => remaining.some((tab) => tab.name === member));
            mount(survivor ?? remaining[0]?.name);
            return;
        }
        // A non-focused split member died — remount the shrunken group around the still-focused session.
        mount(activeName.value);
    };

    // Open a background process's read-only log view as a tab and focus it (the processes popover's View logs).
    const viewProcess = async (name: string): Promise<void> => {
        viewedProcesses.add(name);
        await refresh();
        mount(name);
    };

    const focus = async (name: string): Promise<void> => {
        if (!order.value.some((tab) => tab.name === name)) {
            // Focusing IS the explicit open that reveals a hidden agent shell (the chat's Bash card, the
            // AI-terminals popover) — recorded before the relist, which is what decides whether it tabs.
            // Unconditional: the set is only ever consulted for "agent" sessions, so a shell or panel name
            // landing in it changes nothing.
            revealedAgents.add(name);
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
        // Only the agent channel surfaces, and by default its shells don't tab (useAgentTerminals) — so the
        // retry loop has nothing to wait for. One relist still earns its keep: it writes the shared session
        // list, which is what makes the AI-terminals popover show the turn's shell the moment it starts rather
        // than up to a poll later.
        if (!showAgentTerminals.value) {
            await refresh();
            return;
        }
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

    // Merge the named sessions into one split group at the first involved group's strip position (VSCode's
    // Join Terminals on a multi-selection). Callers pass names in strip order, so the merged pane reads the
    // same left-to-right as the strip did.
    const joinTabs = (names: string[]): void => {
        if (names.length < 2) {
            return;
        }
        const joining = new Set(names);
        const next: string[][] = [];
        let placed = false;
        for (const group of groups.value) {
            const kept = group.filter((member) => !joining.has(member));
            if (kept.length < group.length && !placed) {
                next.push([...names]);
                placed = true;
            }
            if (kept.length > 0) {
                next.push(kept);
            }
        }
        if (!placed) {
            return;
        }
        groups.value = next;
        persistGroups();
        mount(activeName.value !== undefined && joining.has(activeName.value) ? activeName.value : names[0]);
    };

    // Move one session out of its split group into its own tab, placed right after the group it left.
    const unsplit = (name: string): void => {
        const index = groups.value.findIndex((group) => group.includes(name) && group.length > 1);
        if (index === -1) {
            return;
        }
        const next = groups.value.map((group, at) => (at === index ? group.filter((member) => member !== name) : group));
        next.splice(index + 1, 0, [name]);
        groups.value = next;
        persistGroups();
        mount(name);
    };

    if (source.create === undefined || source.kill === undefined) {
        return {
            order,
            groups,
            processes,
            activeName,
            attach,
            detach,
            refresh,
            focus,
            surface,
            viewProcess,
            switchTab,
            sendInput,
            joinTabs,
            unsplit,
        };
    }
    const create = source.create;
    const kill = source.kill;
    // Creation is implicit — opening the socket runs `tmux new-session -A` — so for the length of that
    // handshake the daemon does not list the session. The claim (addPendingTerminal) is what carries it across:
    // it counts on the rail the moment the tab appears, and it survives the relists that would otherwise drop
    // the tab out from under a live socket. Retired by endSession, or by the first list that names it.
    const claim = (name: string): TerminalTab => {
        const tab: TerminalTab = { name, kind: `shell`, running: true };
        addPendingTerminal(tab);
        sessionOf(name);
        return tab;
    };
    // Open a fresh tab and switch to it.
    const newTab = (): void => {
        const tab = claim(create());
        order.value = [...order.value, tab];
        groups.value = [...groups.value, [tab.name]];
        persistGroups();
        mount(tab.name);
    };
    // Split the pane: open a fresh shell INSIDE `name`'s group, right after it, and focus it.
    const splitTab = (name: string): void => {
        const tab = claim(create());
        order.value = [...order.value, tab];
        const grouped = groups.value.some((group) => group.includes(name));
        groups.value = grouped
            ? groups.value.map((group) => {
                  const at = group.indexOf(name);
                  return at === -1 ? group : group.toSpliced(at + 1, 0, tab.name);
              })
            : [...groups.value, [name, tab.name]];
        persistGroups();
        mount(tab.name);
    };
    // Close a tab (its × button): kill the tmux session for good, then drop its client state. A process log
    // view only hides — stopping a background process is the popover's explicit Stop, never a tab close. The
    // kill runs unawaited: the strip is right immediately (endSession), and the source settles the shared
    // session list once the daemon confirms.
    const closeTab = (name: string): void => {
        if (!viewedProcesses.has(name)) {
            void kill(name);
        }
        endSession(name);
    };
    // The strip's multi-selection kill — one closeTab per name; endSession refocuses as the set shrinks.
    const killTabs = (names: string[]): void => {
        for (const name of names) {
            closeTab(name);
        }
    };
    // Restart the active shell: kill its session and open a fresh one IN ITS PLACE — same group, same slot —
    // (auto-reconnect handles a mere dropped socket, so this is for "give me a clean shell").
    const restart = (): void => {
        const name = activeName.value;
        if (name === undefined) {
            return;
        }
        void kill(name);
        const session = cache.get(name);
        if (session !== undefined) {
            disposeTerminalSession(session);
            cache.delete(name);
        }
        const tab = claim(create());
        order.value = [...order.value.filter((entry) => entry.name !== name), tab];
        groups.value = groups.value.map((group) => group.map((member) => (member === name ? tab.name : member)));
        persistGroups();
        activeName.value = undefined;
        mount(tab.name);
    };
    return {
        order,
        groups,
        processes,
        activeName,
        attach,
        detach,
        refresh,
        focus,
        surface,
        viewProcess,
        switchTab,
        sendInput,
        joinTabs,
        unsplit,
        newTab,
        closeTab,
        splitTab,
        killTabs,
        restart,
    };
};
