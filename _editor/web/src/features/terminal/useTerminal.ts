import { computed, type ComputedRef, ref, type Ref, watch } from "vue";
import { activeSandboxId } from "../sandbox/overview/activeSandbox";
import { showWorkTerminals } from "./useWorkTerminals";
import { addPendingTerminal, dropPendingTerminal, refreshTerminals } from "./terminalsQuery";
import { pruneTerminalMeta } from "./terminalMeta";
import {
    createTerminalSession,
    disposeTerminalSession,
    mountTerminalSession,
    parkTerminalSession,
    retypeTerminalSession,
    type TerminalSession,
} from "./terminalSession";
import { useTextSize } from "@intentic/ui/text-size";

// Multi-tab terminal state for the terminal panel: an instance per surface over one shared session cache. `kind` gates
// restart and the background-process split: process sessions tab only as log views, agent/job only once revealed or
// while showWorkTerminals is on. `groups` is the remembered arrangement intersected with what's listed.

export interface TerminalTab {
    readonly name: string;
    // Shown on the pill; absent shows the pill's position index instead.
    readonly label?: string;
    // false dims the pill (an untracked session) and offers it to the sweep; required, never merely unknown.
    readonly running: boolean;
    // Epoch ms of last output, 0 meaning unknown (not 1970); feeds the inactive sweep and the work popover's dates.
    readonly activityAt: number;
    // shell (numbered), panel (dev server), agent (Bash), job (daemon flow), process (background service).
    readonly kind: "shell" | "panel" | "agent" | "job" | "process";
    // Present when this session is a declared extension process, addressing its /extensions start/stop routes.
    readonly extensionId?: string;
    readonly processName?: string;
    // What's running right now, absent at a bare prompt; the only thing that tells an idle shell from a live build.
    readonly command?: string;
}

// Work surfaces (agent/job), as opposed to places the user keeps; drives hiddenFromStrip and retireFinished.
const isWork = (tab: TerminalTab): boolean => tab.kind === `agent` || tab.kind === `job`;

export interface TerminalTabsSource {
    readonly list: () => Promise<TerminalTab[]>;
    readonly create?: () => string;
    // Resolves once the shared list has settled; never rejects, since a failed kill is the source's to reconcile.
    readonly kill?: (name: string) => Promise<void>;
}

// A process tab is a read-only log view: stdin off. The container sizes the PTY at birth, even hidden.
const createPane = (tab: TerminalTab, onExit: (name: string) => void, spawnWithin: HTMLElement | undefined): TerminalSession =>
    createTerminalSession(tab.name, onExit, tab.kind === `process`, spawnWithin);

// Sandbox switch: drops every cached socket and bumps the epoch so mounted surfaces reset and relist. Sessions
// themselves keep running; reattaching replays their history from tmux.
export const disposeAllSessions = (): void => {
    for (const session of cache.values()) {
        disposeTerminalSession(session);
    }
    cache.clear();
    epoch.value += 1;
};

// Shared session cache, one xterm+socket per name; disposed only when a session deliberately ends.
const cache = new Map<string, TerminalSession>();

// Live session behind a tab name, for surfaces acting on the terminal itself (copy/paste/scrollback).
export const terminalSessionOf = (name: string): TerminalSession | undefined => cache.get(name);

// Bumped whenever the cache is wiped wholesale (sandbox switch); mounted surfaces watch it.
const epoch = ref(0);

// Terminal glyphs are drawn at a size CSS can't rescale; every cached session re-types on a size change.
watch(useTextSize().scale, () => {
    for (const session of cache.values()) {
        retypeTerminalSession(session);
    }
});

export interface TerminalTabs {
    readonly order: Ref<TerminalTab[]>;
    // Strip order: ordered groups of session names; every name here is a session that exists.
    readonly groups: ComputedRef<string[][]>;
    // Whether this sandbox has answered: waiting, arrived, or refused; never reverts once arrived.
    readonly answer: Ref<"waiting" | "arrived" | "refused">;
    // Remembered strip shape, drawn as placeholders while `answer` is waiting; never rendered as real tabs.
    readonly remembered: ComputedRef<string[][]>;
    // Managed background processes (`process` kind) from the last list; the processes popover's rows.
    readonly processes: Ref<TerminalTab[]>;
    // Focused session; keystrokes land here and its group is the mounted pane.
    readonly activeName: Ref<string | undefined>;
    // Session an open request is still waiting for; undefined once it arrives or is superseded.
    readonly pending: Ref<string | undefined>;
    // Resolves true if attaching auto-created the first shell for an empty panel; never rejects.
    readonly attach: (el: HTMLElement, awaited?: string) => Promise<boolean>;
    readonly detach: () => void;
    readonly refresh: () => Promise<void>;
    // Focuses a session, relisting first if it isn't tabbed yet (a row's terminal button).
    readonly focus: (name: string) => Promise<void>;
    // Relists so a newly-appeared session tabs without mounting or stealing the active tab.
    readonly surface: () => Promise<void>;
    // Opens (and focuses) a background process's read-only log view as a tab.
    readonly viewProcess: (name: string) => Promise<void>;
    readonly switchTab: (name: string) => void;
    // Injects input into the active session, the same path as a keystroke (the touch extra-keys row).
    readonly sendInput: (data: string) => void;
    // Merges the named sessions into one split group at the first one's strip position.
    readonly joinTabs: (names: string[]) => void;
    // Moves one session out of its split group into its own tab, right after the group.
    readonly unsplit: (name: string) => void;
    readonly newTab?: () => void;
    // Opens a fresh shell inside the named session's group, splitting the pane.
    readonly splitTab?: (name: string) => void;
    // Ends sessions, one or a whole selection; the only way out, so a kill always goes through the panel's confirm.
    readonly killTabs?: (names: string[]) => void;
    readonly restart?: () => void;
}

// One surface's tab state. `storageKey` namespaces the remembered active tab and grouping; `onEmpty` fires when the
// last tab ends.
export const createTerminalTabs = (source: TerminalTabsSource, storageKey: string, onEmpty: () => void): TerminalTabs => {
    const activeKey = (): string => `ui-${storageKey}-terminal-active.${activeSandboxId.value ?? `local`}`;
    const groupsKey = (): string => `ui-${storageKey}-terminal-groups.${activeSandboxId.value ?? `local`}`;
    const order = ref<TerminalTab[]>([]);
    const processes = ref<TerminalTab[]>([]);
    // Process sessions the user opened a log view for; the only `process` sessions that appear in `order`.
    const viewedProcesses = new Set<string>();
    // Work sessions revealed by an explicit open while the preference is off; lasts this surface's lifetime only.
    const revealed = new Set<string>();
    // Session an open request is still waiting to see listed; a second request supersedes the first.
    const pending = ref<string | undefined>(undefined);
    const activeName = ref<string | undefined>(undefined);
    let container: HTMLElement | undefined;
    // Session names whose hosts are currently in the container, the active group's members.
    let mountedNames: string[] = [];

    const readGroups = (): string[][] => {
        try {
            const parsed: unknown = JSON.parse(window.localStorage.getItem(groupsKey()) ?? `[]`);
            if (Array.isArray(parsed)) {
                return parsed.filter((group): group is string[] => Array.isArray(group) && group.every((name) => typeof name === `string`));
            }
        } catch {
            // Falls through to the empty return below.
        }
        return [];
    };
    // User's split layout per sandbox: which sessions sit together, kept even while a member is temporarily absent.
    const arrangement = ref<string[][]>(readGroups());
    const persistGroups = (): void => {
        try {
            window.localStorage.setItem(groupsKey(), JSON.stringify(arrangement.value));
        } catch {
            // Storage may be unavailable (private mode); the in-memory ref still holds.
        }
    };

    // Arrangement intersected with what's actually listed, so a pill never points at an unmountable session.
    const groups = computed<string[][]>(() => {
        const listed = order.value.map((tab) => tab.name);
        const known = new Set(listed);
        const kept = arrangement.value.map((group) => group.filter((name) => known.has(name))).filter((group) => group.length > 0);
        const grouped = new Set(kept.flat());
        return [...kept, ...listed.filter((name) => !grouped.has(name)).map((name) => [name])];
    });

    // Strip shapes to draw while sessions are still arriving, since arrangement loads before the list does.
    const remembered = computed<string[][]>(() => arrangement.value.map((group) => [...group]));
    const answer = ref<"waiting" | "arrived" | "refused">(`waiting`);

    const groupOf = (name: string): string[] => arrangement.value.find((group) => group.includes(name)) ?? [name];

    // Kinds listed by the daemon that don't tab on their own: unopened processes, and (unless revealed or the
    // preference is on) agent/job sessions.
    const hiddenFromStrip = (tab: TerminalTab): boolean => {
        if (tab.kind === `process`) {
            return !viewedProcesses.has(tab.name);
        }
        return isWork(tab) && !showWorkTerminals.value && !revealed.has(tab.name);
    };

    // Drops a revealed session's reveal once it finishes, unless it's the active tab or not yet on the strip (spares an
    // unseen reveal).
    const retireFinished = (tabs: TerminalTab[]): void => {
        const onStrip = new Set(order.value.map((tab) => tab.name));
        for (const tab of tabs) {
            if (isWork(tab) && !tab.running && onStrip.has(tab.name) && tab.name !== activeName.value) {
                revealed.delete(tab.name);
            }
        }
    };

    // Takes the tab, not just a name, since only the daemon's answer says what pane kind it needs; a cache hit ignores
    // it.
    const sessionOf = (tab: TerminalTab): TerminalSession => {
        const cached = cache.get(tab.name);
        if (cached !== undefined) {
            // Sessions outlive the instance that created them; rebind so this instance's list gets the exit.
            cached.onExit = endSession;
            return cached;
        }
        const session = createPane(tab, endSession, container);
        cache.set(tab.name, session);
        return session;
    };

    // Mounts `name`'s whole group into the container side by side and focuses it; a focusin on any cell retargets input
    // and the strip highlight without remounting.
    const mount = (name: string | undefined): void => {
        if (name === undefined || container === undefined || !order.value.some((tab) => tab.name === name)) {
            return;
        }
        const listed = new Map(order.value.map((tab) => [tab.name, tab]));
        const group = groupOf(name).filter((member) => listed.has(member));
        for (const mounted of mountedNames) {
            const session = cache.get(mounted);
            if (session !== undefined) {
                parkTerminalSession(session);
            }
        }
        container.replaceChildren();
        container.classList.toggle(`term-split`, group.length > 1);
        for (const member of group) {
            const tab = listed.get(member);
            if (tab === undefined) {
                continue;
            }
            const cell = document.createElement(`div`);
            cell.className = `term-cell`;
            // Which session this pane is, for a right-click to find the terminal under the pointer in a split.
            cell.dataset[`session`] = member;
            cell.addEventListener(`focusin`, () => {
                activeName.value = member;
                window.localStorage.setItem(activeKey(), member);
            });
            container.append(cell);
            mountTerminalSession(sessionOf(tab), cell, member === name);
        }
        mountedNames = group;
        activeName.value = name;
        window.localStorage.setItem(activeKey(), name);
    };

    // Folds a landed list into the arrangement: dead names drop, empty groups collapse, new sessions get their own
    // group. Only runs on a list that actually arrived, so a failed one can't flatten a split.
    const reconcileGroups = (tabs: TerminalTab[]): void => {
        const tabbed = new Set(tabs.map((tab) => tab.name));
        const kept = arrangement.value.map((group) => group.filter((name) => tabbed.has(name))).filter((group) => group.length > 0);
        const grouped = new Set(kept.flat());
        for (const tab of tabs) {
            if (!grouped.has(tab.name)) {
                kept.push([tab.name]);
            }
        }
        arrangement.value = kept;
        persistGroups();
    };

    // Re-lists the surface's sessions; every tabbed one connects immediately, even hidden, so switching to it is
    // instant. `container` is checked on both sides of the await so a torn-down instance can't write stale state.
    const relist = async (): Promise<void> => {
        if (container === undefined) {
            return;
        }
        const ticket = ++asked;
        const listed = await source.list();
        if (container === undefined) {
            return;
        }
        // A stale ticket's answer; dropped since it describes a sandbox that's since moved on.
        if (ticket <= answered) {
            return;
        }
        answered = ticket;
        pruneTerminalMeta(new Set(listed.map((tab) => tab.name)));
        processes.value = listed.filter((tab) => tab.kind === `process`);
        // Before the filter, so a session that just finished loses its reveal in time for this same list.
        retireFinished(listed);
        const tabs = listed.filter((tab) => !hiddenFromStrip(tab));
        order.value = tabs;
        // This daemon has now said what's running, so an empty strip means it, not 'still asking'.
        answer.value = `arrived`;
        reconcileGroups(tabs);
        for (const tab of tabs) {
            sessionOf(tab);
        }
        const tabbed = new Set(tabs.map((tab) => tab.name));
        // Standing wait's other end: opens whatever was pending, via its log view if it turned out to be a process.
        if (pending.value !== undefined && listed.some((tab) => tab.name === pending.value)) {
            const arrived = pending.value;
            pending.value = undefined;
            if (processes.value.some((process) => process.name === arrived)) {
                void viewProcess(arrived);
            } else {
                mount(arrived);
            }
            return;
        }
        if (activeName.value === undefined || !tabbed.has(activeName.value)) {
            // What to open onto: prefer a still-running remembered tab, else the first live one, else any tab.
            const rememberedActive = window.localStorage.getItem(activeKey()) ?? undefined;
            const live = tabs.find((tab) => tab.running);
            const restorable = tabs.find((tab) => tab.name === rememberedActive && tab.running);
            mount((restorable ?? live ?? tabs[0])?.name);
        } else if (mountedNames.some((name) => !tabbed.has(name))) {
            // Focused session survived but a groupmate vanished; remount the shrunken group.
            mount(activeName.value);
        }
    };

    // Relists are ordered by when asked, not when they answer; a stale answer is discarded, not applied.
    let asked = 0;
    let answered = 0;

    // A refused list has to be asked again, since nothing else reacts to a request that failed; retries are few,
    // spaced, and stop once one succeeds or the panel closes.
    const RETRY_MS = [500, 1_500, 4_000] as const;
    let retried = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const stopRetrying = (): void => {
        clearTimeout(retryTimer);
        retryTimer = undefined;
        retried = 0;
    };
    const retryLater = (): void => {
        const wait = RETRY_MS[retried];
        if (wait === undefined && answer.value === `waiting`) {
            // Nothing more is coming; said explicitly so the panel stops promising terminals it's no longer asking for.
            answer.value = `refused`;
        }
        // Out of tries, torn down, or already waiting on one: never queue retries.
        if (wait === undefined || container === undefined || retryTimer !== undefined) {
            return;
        }
        retried += 1;
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            if (container !== undefined) {
                void refresh().catch(() => undefined);
            }
        }, wait);
    };

    const refresh = (): Promise<void> => {
        // Asked immediately so a caller here is never held up by someone else's list.
        const next = relist();
        // Watched, not awaited: the caller keeps this promise; the retry above is this instance's own concern.
        next.then(stopRetrying, retryLater);
        return next;
    };

    // Standing wait's own clock: while a name is awaited, relist every few seconds for a couple of minutes in case the
    // daemon's push frame is missed, stopping once listed or torn down.
    const PENDING_RELIST_MS = 5_000;
    const PENDING_RELIST_MAX_MS = 120_000;
    let pendingRelist: ReturnType<typeof setInterval> | undefined;
    const stopPendingRelist = (): void => {
        clearInterval(pendingRelist);
        pendingRelist = undefined;
    };
    watch(pending, (name) => {
        stopPendingRelist();
        if (name === undefined) {
            return;
        }
        const since = Date.now();
        pendingRelist = setInterval(() => {
            if (container === undefined || Date.now() - since > PENDING_RELIST_MAX_MS) {
                stopPendingRelist();
                return;
            }
            void refresh().catch(() => undefined);
        }, PENDING_RELIST_MS);
    });

    // Sandbox switch while mounted: sessions are already disposed; drop stale tab state and relist anew.
    watch(epoch, () => {
        order.value = [];
        processes.value = [];
        // New sandbox's own arrangement, so its splits return as left; no tab is drawn until its list lands.
        arrangement.value = readGroups();
        // Nothing asked of this daemon yet, ahead of the relist, so no frame can claim it has no terminals.
        answer.value = `waiting`;
        viewedProcesses.clear();
        // The wait was for a session on the old daemon; nothing here will ever answer it.
        pending.value = undefined;
        activeName.value = undefined;
        mountedNames = [];
        // Fresh daemon, fresh tries; whatever the old one refused is spent.
        stopRetrying();
        // Every question still out is void: its answer would paint the old sandbox's sessions onto this one.
        answered = asked;
        void refresh().catch(() => undefined);
    });

    // Preference toggled while open: relist so work terminals arrive or leave; sockets stay parked either way.
    watch(showWorkTerminals, () => {
        // A dropped list leaves the strip as is and the retry asks again; nothing to report here.
        void refresh()
            .catch(() => undefined)
            .then(() => {
                // Hiding the last tab would leave a blank panel, so open a shell instead, same as an empty attach().
                if (order.value.length === 0 && source.create !== undefined) {
                    newTab();
                }
            });
    });

    // `awaited` is the session the panel opened for, suppressing the empty-panel shell it would otherwise spawn.
    // `pending` is the same fact arriving after mount, so the create decision waits on it too.
    const attach = async (el: HTMLElement, awaited?: string): Promise<boolean> => {
        container = el;
        // A refused first list isn't this call's to throw; it's already `answer`/`retryLater`'s to report.
        let listed = true;
        await refresh().catch(() => {
            listed = false;
        });
        // Torn down or re-attached mid-list, or the list never landed: don't spawn an unverified empty-panel shell.
        if (container !== el || !listed) {
            return false;
        }
        if (order.value.length === 0 && awaited === undefined && pending.value === undefined && source.create !== undefined) {
            newTab();
            return true;
        }
        return false;
    };

    // Removes mounted hosts from the DOM without touching any session; sockets and scrollback stay alive. Dropping
    // `container` retires this instance, so every async path re-checks it first.
    const detach = (): void => {
        for (const mounted of mountedNames) {
            const session = cache.get(mounted);
            if (session !== undefined) {
                parkTerminalSession(session);
            }
        }
        mountedNames = [];
        container = undefined;
        // Nobody is left to show the answer to.
        stopRetrying();
    };

    // A session ended (tab close or the daemon's exit frame): dispose it, drop the tab, and focus a neighbour or hand
    // off to onEmpty.
    const endSession = (name: string): void => {
        viewedProcesses.delete(name);
        revealed.delete(name);
        // Waiting on the session that just ended is waiting for nothing.
        if (pending.value === name) {
            pending.value = undefined;
        }
        // This name is spent either way; a lingering claim would keep it in the shared list and the rail's count.
        dropPendingTerminal(name);
        const session = cache.get(name);
        if (session !== undefined) {
            disposeTerminalSession(session);
            cache.delete(name);
        }
        const group = arrangement.value.find((members) => members.includes(name));
        arrangement.value = arrangement.value.map((members) => members.filter((member) => member !== name)).filter((members) => members.length > 0);
        persistGroups();
        const remaining = order.value.filter((tab) => tab.name !== name);
        order.value = remaining;
        // An empty strip retires the panel however the last tab went, ahead of deciding what needs remounting.
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
        // A non-focused split member died; remount the shrunken group around the still-focused session.
        mount(activeName.value);
    };

    // Opens a background process's read-only log view as a tab and focuses it.
    const viewProcess = async (name: string): Promise<void> => {
        viewedProcesses.add(name);
        await refresh();
        mount(name);
    };

    const focus = async (name: string): Promise<void> => {
        if (!order.value.some((tab) => tab.name === name)) {
            // Focusing is the explicit open that reveals a hidden work terminal, recorded before the relist reads it.
            revealed.add(name);
            // Standing wait: refresh mounts the name once it's listed, driven by the daemon's push frame, not a timer.
            pending.value = name;
            await refreshTerminals();
            await refresh();
            return;
        }
        // A background-process session never tabs directly; route it through its read-only log view.
        if (processes.value.some((process) => process.name === name)) {
            await viewProcess(name);
            return;
        }
        mount(name);
    };

    // Relists so a newly-appeared session shows up as a tab without mounting it; refresh() keeps the current active
    // tab.
    const surface = async (): Promise<void> => {
        await refresh();
    };

    // Switching away lets a finished work terminal's reveal go, since it was held only for being on screen; relists
    // only if that changed anything.
    const switchTab = (name: string): void => {
        mount(name);
        const held = revealed.size;
        retireFinished(order.value);
        if (revealed.size !== held) {
            void refresh().catch(() => undefined);
        }
    };

    // Routes programmatic input through xterm's own input handler, reusing the socket wiring a keystroke uses.
    const sendInput = (data: string): void => {
        const name = activeName.value;
        const session = name === undefined ? undefined : cache.get(name);
        if (session !== undefined) {
            session.term.input(data, true);
        }
    };

    // Merges the named sessions into one split group at the first involved group's strip position; callers pass names
    // in strip order.
    const joinTabs = (names: string[]): void => {
        if (names.length < 2) {
            return;
        }
        const joining = new Set(names);
        const next: string[][] = [];
        let placed = false;
        for (const group of arrangement.value) {
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
        arrangement.value = next;
        persistGroups();
        mount(activeName.value !== undefined && joining.has(activeName.value) ? activeName.value : names[0]);
    };

    // Moves one session out of its split group into its own tab, right after the group it left.
    const unsplit = (name: string): void => {
        const index = arrangement.value.findIndex((group) => group.includes(name) && group.length > 1);
        if (index === -1) {
            return;
        }
        const next = arrangement.value.map((group, at) => (at === index ? group.filter((member) => member !== name) : group));
        next.splice(index + 1, 0, [name]);
        arrangement.value = next;
        persistGroups();
        mount(name);
    };

    if (source.create === undefined || source.kill === undefined) {
        return {
            order,
            groups,
            answer,
            remembered,
            processes,
            activeName,
            pending,
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
    // Claims a session before the daemon lists it (creation runs `tmux new-session -A` asynchronously); the claim
    // counts on the rail and survives relists until endSession or the first list names it.
    const claim = (name: string): TerminalTab => {
        const tab = { name, kind: `shell` as const, running: true, activityAt: Date.now() };
        addPendingTerminal(tab);
        sessionOf(tab);
        return tab;
    };
    // Opens a fresh tab and switches to it.
    const newTab = (): void => {
        const tab = claim(create());
        order.value = [...order.value, tab];
        arrangement.value = [...arrangement.value, [tab.name]];
        persistGroups();
        mount(tab.name);
    };
    // Splits the pane: opens a fresh shell inside `name`'s group, right after it, and focuses it.
    const splitTab = (name: string): void => {
        const tab = claim(create());
        order.value = [...order.value, tab];
        const grouped = arrangement.value.some((group) => group.includes(name));
        arrangement.value = grouped
            ? arrangement.value.map((group) => {
                  const at = group.indexOf(name);
                  return at === -1 ? group : group.toSpliced(at + 1, 0, tab.name);
              })
            : [...arrangement.value, [name, tab.name]];
        persistGroups();
        mount(tab.name);
    };
    // Ends one tab: kills the tmux session, then drops its client state; a process log view only hides, since stopping
    // it is the popover's job.
    const endTab = (name: string): void => {
        if (!viewedProcesses.has(name)) {
            void kill(name);
        }
        endSession(name);
    };
    // Kills a pill or a whole selection; endSession refocuses as the set shrinks.
    const killTabs = (names: string[]): void => {
        for (const name of names) {
            endTab(name);
        }
    };
    // Restarts the active shell: kills its session and opens a fresh one in its place, same group and slot.
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
        arrangement.value = arrangement.value.map((group) => group.map((member) => (member === name ? tab.name : member)));
        persistGroups();
        activeName.value = undefined;
        mount(tab.name);
    };
    return {
        order,
        groups,
        answer,
        remembered,
        processes,
        activeName,
        pending,
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
        splitTab,
        killTabs,
        restart,
    };
};
