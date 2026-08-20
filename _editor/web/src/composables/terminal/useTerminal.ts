import { computed, type ComputedRef, ref, type Ref, watch } from "vue";
import { activeSandboxId } from "../sandbox/activeSandbox";
import { showWorkTerminals } from "./useWorkTerminals";
import { addPendingTerminal, dropPendingTerminal, refreshTerminals } from "./terminalsQuery";
import { pruneTerminalMeta } from "./terminalMeta";
import {
    createTerminalSession,
    disposeTerminalSession,
    mountTerminalSession,
    parkTerminalSession,
    persistScrollback,
    retypeTerminalSession,
    type TerminalSession,
} from "./terminalSession";
import { useTextSize } from "@intentic/ui/text-size";

/* Multi-tab terminal state for the terminal panel (pages/TerminalPanel.vue): an instance (createTerminalTabs)
 * over ONE module-level session cache, so a session's xterm/socket/scrollback survives unmount, collapse, and
 * navigation, shells and dev-server terminals get identical live-tab semantics. The TerminalTabsSource
 * describes the tab set: how to list sessions, and how to create/kill them. `kind` gates restart (shells
 * only, restarting a dev-server tab is Start's job) and the background-process split: "process" sessions
 * never tab by themselves, they live in `processes` (the popover's list) and tab only as read-only log
 * views via viewProcess, whose × merely hides them (killing a background process is the popover's explicit
 * Stop, never a tab close). "agent" and "job" sessions follow the same shape for a different reason: they are
 * evidence about work that ran rather than tabs the user keeps, so unless `showWorkTerminals` is on they tab
 * only once explicitly opened, and only until they finish, see useWorkTerminals and `revealed` below.
 *
 * Tabs arrange into GROUPS (VSCode's split terminals): `groups` is the strip order, each entry an ordered
 * list of session names rendered side by side in one pane when active. Grouping is pure client view state
 * (tmux sees flat sessions), remembered per storageKey AND per sandbox; the daemon's list stays the truth for
 * which sessions exist, so `groups` is DERIVED, the remembered arrangement intersected with what is listed,
 * newcomers tabbing at the end. A pill therefore always has a session behind it. */

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
    // background process (an extension's declared processes, dockerd, read-only log views).
    readonly kind: "shell" | "panel" | "agent" | "job" | "process";
    // A process row that maps to an installed extension's declared process, the address for its
    // /extensions start/stop routes (absent on docker and orphaned sessions).
    readonly extensionId?: string;
    readonly processName?: string;
    // What this session is running RIGHT NOW ("pnpm build", "vim"), absent while it waits at its prompt. The
    // difference `running` cannot draw, a shell is `running` either way, and therefore the only thing that
    // tells a × aimed at an idle shell from one about to end a build. The strip marks it and the kill confirms
    // on it (pages/TerminalPanel.vue).
    readonly command?: string;
}

// The surfaces WORK runs on, as opposed to the PLACES the user keeps: an agent's Bash shell and the daemon's
// job sessions are records of something that ran, and the strip treats them accordingly (hiddenFromStrip,
// retireFinished).
const isWork = (tab: TerminalTab): boolean => tab.kind === `agent` || tab.kind === `job`;

export interface TerminalTabsSource {
    readonly list: () => Promise<TerminalTab[]>;
    readonly create?: () => string;
    // Resolves once the daemon has answered and the source has settled the shared session list against that
    // answer, which is the only reason it is async at all. The tab is gone from the strip long before then
    // (endSession is synchronous), so nothing awaits it for the view; callers `void` it. NEVER rejects, for
    // that same reason: a kill that failed is the source's to reconcile and report, and a promise nobody
    // awaits is the one place a throw goes nowhere.
    readonly kill?: (name: string) => Promise<void>;
}

// A background process's tab is a LOG VIEW: stdin off, keystrokes never reach the PTY. The container sizes the
// PTY at birth (even for a tab that stays hidden, it would mount here).
const createPane = (tab: TerminalTab, onExit: (name: string) => void, spawnWithin: HTMLElement | undefined): TerminalSession =>
    createTerminalSession(tab.name, onExit, tab.kind === `process`, spawnWithin);

/* Sandbox switch: every cached socket points at the OLD daemon, drop them all and bump the epoch so a mounted
 * surface resets its tab state and relists against the new daemon.
 *
 * `left` is the sandbox being LEFT, which the caller has to tell us: the active id has already moved on by the
 * time this runs. Each session's scrollback is snapshotted under it on the way out, exactly as a page reload
 * does, because a switch is not the end of these terminals, they keep running, and coming back to one that
 * showed a suite's output should not show an empty pane with a fresh prompt in it. */
export const disposeAllSessions = (left: string | undefined): void => {
    for (const session of cache.values()) {
        persistScrollback(session, left);
        disposeTerminalSession(session);
    }
    cache.clear();
    epoch.value += 1;
};

// The shared session cache, one xterm + socket per session name, owned by no surface. An entry is disposed
// only when its session deliberately ends (tab ×, restart, or the daemon's exit frame); a mere unmount detaches
// the DOM host and keeps streaming. sessionOf rebinds a cached session's exit handler to the instance that
// touched it last, so an exit always updates a LIVE surface's tab state.
const cache = new Map<string, TerminalSession>();

// The live session behind a tab name, for the surfaces that act on a terminal rather than on the tab set, the
// grid's own context menu (copy / paste / scrollback). Undefined for a name nothing has mounted.
export const terminalSessionOf = (name: string): TerminalSession | undefined => cache.get(name);

// Bumped whenever the cache is wiped wholesale (sandbox switch), mounted surfaces watch it.
const epoch = ref(0);

// Snapshot every live terminal's scrollback on reload/navigation, createTerminalSession restores it.
window.addEventListener(`pagehide`, () => {
    for (const session of cache.values()) {
        persistScrollback(session);
    }
});

// The app's text size reaches everything drawn in CSS by itself; a terminal draws its own glyphs, so the cache
// is the one place that knows every session there is to re-type. Parked sessions included, they are streaming
// and will be looked at again.
watch(useTextSize().scale, () => {
    for (const session of cache.values()) {
        retypeTerminalSession(session);
    }
});

export interface TerminalTabs {
    readonly order: Ref<TerminalTab[]>;
    // The strip: ordered groups of session names; a group of one is a plain tab, more are split side by side.
    // Derived from `order`, so every name here is a session that exists (see `groups` below).
    readonly groups: ComputedRef<string[][]>;
    /* WHETHER THIS SANDBOX HAS ANSWERED YET, and if it refused. An empty strip means three different things,
     * "nothing runs here", "we haven't asked yet", and "we asked and got nothing back", and a panel that states
     * the first while it means the second has to take it back a beat later, which is worse than a spinner. The
     * same distinction the chat draws for provider accounts (chat/providerAccounts.ts).
     *
     * `waiting` until a list lands, `arrived` once one has, `refused` when asking has run out of tries. A list
     * that fails AFTER one arrived leaves this on `arrived`: the strip still shows the last thing this daemon
     * actually said, and a dropped refresh is no reason to unsay it. */
    readonly answer: Ref<"waiting" | "arrived" | "refused">;
    /* The strip this sandbox was left with, as SHAPES rather than tabs, how many pills, and how wide each one
     * is. What a panel draws placeholders from while `answer` is `waiting`: it is known instantly (it comes out
     * of storage) whereas the sessions arrive over a tunnel, so it is the one thing available to say "your
     * terminals are coming back" with. Never rendered as tabs, see `groups` for why a name in here is not yet
     * a tab. */
    readonly remembered: ComputedRef<string[][]>;
    // The managed background processes ("process" kind) from the last list, the processes popover's rows.
    readonly processes: Ref<TerminalTab[]>;
    // The FOCUSED session, keystrokes land here; its group is the mounted pane.
    readonly activeName: Ref<string | undefined>;
    // The session an open request is still waiting for, if any, undefined the moment it arrives (or the
    // request is superseded). What the panel says "this is starting" about.
    readonly pending: Ref<string | undefined>;
    // Resolves true when attaching auto-created the first shell (an empty managed panel opens with one, unless
    // `awaited` names the session the panel was opened for, see attach). NEVER rejects: a list this instance
    // could not get is its own to report and to ask again about, and the surface attaching has work to do
    // afterwards that a throw from here would silently cost it.
    readonly attach: (el: HTMLElement, awaited?: string) => Promise<boolean>;
    readonly detach: () => void;
    readonly refresh: () => Promise<void>;
    // Focus a specific session, refreshing the list first when it isn't tabbed yet (a row's terminal button).
    readonly focus: (name: string) => Promise<void>;
    // Relist so a session that just appeared tabs without being mounted, never steals the active tab.
    readonly surface: () => Promise<void>;
    // Open (and focus) a background process's read-only log view as a tab.
    readonly viewProcess: (name: string) => Promise<void>;
    readonly switchTab: (name: string) => void;
    // Inject input into the active session (the touch extra-keys row), same path as a keystroke.
    readonly sendInput: (data: string) => void;
    // Merge the named sessions (strip order) into one split group at the first one's position.
    readonly joinTabs: (names: string[]) => void;
    // Move one session out of its split group into its own tab, right after the group.
    readonly unsplit: (name: string) => void;
    readonly newTab?: () => void;
    // Open a fresh shell INSIDE the named session's group, splitting the pane (VSCode's Split Terminal).
    readonly splitTab?: (name: string) => void;
    /* END SESSIONS, one at a time or a whole selection, and the ONLY way out of here to do it.
     *
     * A per-tab `closeTab` used to sit beside this, and it is deliberately gone. Killing a session is
     * irreversible, so the panel guards it (a confirm when something is running in there, pages/
     * TerminalPanel.vue), and a second, quieter door straight to the same act is precisely how a future call
     * site walks around that guard without anyone noticing. A single kill is a set of one. */
    readonly killTabs?: (names: string[]) => void;
    readonly restart?: () => void;
}

// One surface's tab state. `storageKey` namespaces the remembered active tab + grouping; `onEmpty` fires when
// the last tab ends (the panel closes itself).
export const createTerminalTabs = (source: TerminalTabsSource, storageKey: string, onEmpty: () => void): TerminalTabs => {
    const activeKey = (): string => `ui-${storageKey}-terminal-active.${activeSandboxId.value ?? `local`}`;
    const groupsKey = (): string => `ui-${storageKey}-terminal-groups.${activeSandboxId.value ?? `local`}`;
    const order = ref<TerminalTab[]>([]);
    const processes = ref<TerminalTab[]>([]);
    // Process sessions the user opened a log view for, the only "process" sessions that appear in `order`.
    const viewedProcesses = new Set<string>();
    // Work sessions (agent + job) revealed by an explicit open while the preference is off. Held for this
    // surface's lifetime only, exactly like `viewedProcesses`: a reveal is "show me THIS, now", so it must not
    // outlive the panel or need pruning once the session is gone.
    //
    // That lifetime is the whole fix for the panel that used to reopen onto a row of corpses. A reveal is an
    // answer to a question the user asked while watching; close the panel, walk away for a day of agent turns,
    // and the set comes back empty, so there is nothing to tidy, rather than a broom to reach for.
    const revealed = new Set<string>();
    /* The session an open request is still waiting to see listed, the standing half of `focus`, and what the
     * panel draws its "this is starting" state from. One at a time: a second request supersedes the first,
     * because a user who asks for another terminal is no longer waiting for the last one. */
    const pending = ref<string | undefined>(undefined);
    const activeName = ref<string | undefined>(undefined);
    let container: HTMLElement | undefined;
    // The session names whose hosts are currently in the container, the active group's members.
    let mountedNames: string[] = [];

    const readGroups = (): string[][] => {
        try {
            const parsed: unknown = JSON.parse(window.localStorage.getItem(groupsKey()) ?? `[]`);
            if (Array.isArray(parsed)) {
                return parsed.filter((group): group is string[] => Array.isArray(group) && group.every((name) => typeof name === `string`));
            }
        } catch {
            // fall through to empty
        }
        return [];
    };
    /* HOW THE USER ARRANGED THE STRIP, which sessions sit side by side, and in what order, remembered per
     * sandbox. It is what somebody SET UP, not what exists: a name stays in it while its session is merely
     * absent, which is what carries a split arrangement across a sandbox switch and a reload. */
    const arrangement = ref<string[][]>(readGroups());
    const persistGroups = (): void => {
        try {
            window.localStorage.setItem(groupsKey(), JSON.stringify(arrangement.value));
        } catch {
            // Storage may be unavailable (private mode); the in-memory ref still holds.
        }
    };

    /* WHAT THE STRIP MAY DRAW: the arrangement, intersected with the sessions the daemon actually lists.
     *
     * Derived rather than assigned, because the arrangement and the list are true at different MOMENTS. A
     * sandbox switch restores the arrangement out of storage instantly, while the session list arrives over the
     * tunnel, and until it does (or when it never does, because the list failed) a pill straight from storage
     * is a tab nothing can open: `mount` refuses a name that isn't listed, so the pill sits there unresponsive
     * over a panel saying no terminals are open. Deriving makes that state unrepresentable.
     *
     * A listed session the arrangement has never seen tabs at the end, on its own, the same rule reconcile
     * writes into the arrangement once a list has landed. */
    const groups = computed<string[][]>(() => {
        const listed = order.value.map((tab) => tab.name);
        const known = new Set(listed);
        const kept = arrangement.value.map((group) => group.filter((name) => known.has(name))).filter((group) => group.length > 0);
        const grouped = new Set(kept.flat());
        return [...kept, ...listed.filter((name) => !grouped.has(name)).map((name) => [name])];
    });

    // The shapes a panel may promise while the sessions themselves are still on their way (see the interface).
    const remembered = computed<string[][]>(() => arrangement.value.map((group) => [...group]));
    const answer = ref<"waiting" | "arrived" | "refused">(`waiting`);

    const groupOf = (name: string): string[] => arrangement.value.find((group) => group.includes(name)) ?? [name];

    // The kinds that are listed by the daemon but do not tab on their own: a background process (its lifecycle
    // belongs to the processes popover) and, unless the user asked for them, the terminals WORK runs in, the
    // agent's shells and the daemon's jobs. All become tabs the moment they are explicitly opened, and only
    // then. `retireFinished` below is the other half: a reveal lasts as long as there is something to watch.
    const hiddenFromStrip = (tab: TerminalTab): boolean => {
        if (tab.kind === `process`) {
            return !viewedProcesses.has(tab.name);
        }
        return isWork(tab) && !showWorkTerminals.value && !revealed.has(tab.name);
    };

    // A revealed session that has FINISHED gives its reveal up: the question the reveal answered ("what is this
    // doing?") no longer has an answer, and the pill would otherwise sit there dimmed until the panel closed,
    // which is the litter this whole rule exists to prevent. Two sessions are spared, both for the same reason
    // (nobody has had their look yet):
    //   · the tab the user is on RIGHT NOW, yanking a terminal out from under someone mid-read would be its own
    //     bug, so it stays until they switch away (see `switchTab`)
    //   · one that is not on the strip yet, a reveal of an ALREADY-finished session (the chat's Bash card on a
    //     turn that has ended, the Capabilities page on an install that just landed) is decided in the same
    //     relist that first lists it, and retiring it there would make the click do nothing at all
    // Called on every relist, which is where a liveness change lands.
    const retireFinished = (tabs: TerminalTab[]): void => {
        const onStrip = new Set(order.value.map((tab) => tab.name));
        for (const tab of tabs) {
            if (isWork(tab) && !tab.running && onStrip.has(tab.name) && tab.name !== activeName.value) {
                revealed.delete(tab.name);
            }
        }
    };

    // Takes the TAB, not just a name: what kind of pane a session needs is the daemon's answer, and a name
    // alone can't say. Cache hits ignore the kind entirely, a session's medium never changes under it.
    const sessionOf = (tab: TerminalTab): TerminalSession => {
        const cached = cache.get(tab.name);
        if (cached !== undefined) {
            // Sessions outlive the instance that created them (the panel remounts across v-if / mobile route),
            // rebind so this instance's tab list is the one an exit frame updates.
            cached.onExit = endSession;
            return cached;
        }
        const session = createPane(tab, endSession, container);
        cache.set(tab.name, session);
        return session;
    };

    // Mount `name`'s whole group into the container, one flex cell per member, side by side, and focus
    // `name`. The shared core moves each persistent host across (xterm is open()ed exactly once) and resyncs
    // its PTY grid; a focusin on any cell (clicking into a split) retargets keystroke routing and the strip
    // highlight without remounting.
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
            // Which session this pane is, how a right-click anywhere in the grid finds the terminal under the
            // pointer rather than assuming the focused one (they differ in a split).
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

    // Fold a landed list INTO the remembered arrangement: dead names drop out, empty groups collapse, and every
    // newly-listed session gets its own single-tab group at the end of the strip. Only ever called with the
    // daemon's own answer in hand, which is what makes the pruning safe, a list that failed leaves the
    // arrangement alone, so a momentary outage can't flatten somebody's splits.
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

    // Re-list the surface's sessions. Every tabbed session connects immediately, a hidden tab still streams,
    // so switching to it is instant (tmux redraws at the fitted size). Background processes stay out of the
    // tab set (and hold no idle sockets) until a log view is opened for them.
    //
    // `container` is the liveness gate, checked on BOTH sides of the await: detach() clears it, so a list still
    // in flight when the panel tears down (a fast Ctrl+` off/on) can't write this dead instance's grouping back
    // to localStorage, and, via mount(), can't append a session's host into a detached container, which would
    // STEAL it from the instance that replaced us and leave the live panel a blank pane.
    const relist = async (): Promise<void> => {
        if (container === undefined) {
            return;
        }
        const ticket = ++asked;
        const listed = await source.list();
        if (container === undefined) {
            return;
        }
        // An older question's answer, arriving after a newer one has already been written (see `asked`). It is
        // dropped rather than applied: it describes a sandbox that has since moved on, and writing it is exactly
        // how a push watched its own check get un-listed a beat after it appeared.
        if (ticket <= answered) {
            return;
        }
        answered = ticket;
        pruneTerminalMeta(new Set(listed.map((tab) => tab.name)));
        processes.value = listed.filter((tab) => tab.kind === `process`);
        // Before the filter, not after: a session that just finished has to lose its reveal in time for THIS
        // list to drop it, or it would linger a whole relist longer than the work it was showing.
        retireFinished(listed);
        const tabs = listed.filter((tab) => !hiddenFromStrip(tab));
        order.value = tabs;
        // This daemon has now said what it is running, so an empty strip below means it, and the panel may stop
        // holding a place for terminals that are on their way.
        answer.value = `arrived`;
        reconcileGroups(tabs);
        for (const tab of tabs) {
            sessionOf(tab);
        }
        const tabbed = new Set(tabs.map((tab) => tab.name));
        /* The standing wait's other end: whatever this list just brought in, if it is what somebody asked for,
         * is opened here, whether this relist was the one `focus` ran itself or one the daemon's change frame
         * triggered minutes later. Against the DAEMON's list rather than the strip's, because a background
         * process is listed without ever being a tab: it opens as a log view, which is what puts it on the
         * strip in the first place. */
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
            // What the panel opens ONTO. A finished session is a dead pane whose whole content is an epitaph, so
            // it is the last thing worth restoring someone to, prefer the remembered tab only while it is still
            // alive, then the first live one, and settle for a corpse only when every tab is one.
            const rememberedActive = window.localStorage.getItem(activeKey()) ?? undefined;
            const live = tabs.find((tab) => tab.running);
            const restorable = tabs.find((tab) => tab.name === rememberedActive && tab.running);
            mount((restorable ?? live ?? tabs[0])?.name);
        } else if (mountedNames.some((name) => !tabbed.has(name))) {
            // The focused session survived but a groupmate vanished from the list (killed elsewhere), remount
            // the shrunken group so its host doesn't linger.
            mount(activeName.value);
        }
    };

    /* RELISTS ARE ORDERED BY WHEN THEY WERE ASKED, NOT BY WHEN THEY ANSWER, and these two counters are the
     * whole of that rule.
     *
     * Four things ask for a list, and they ask AT ONCE: the panel's mount, the daemon's `terminals` frame, the
     * focus request a flow just made, and the strip's own refresh button. Each used to fetch and then write
     * `order` whenever its own answer happened to arrive, so a list taken a moment BEFORE the check's session
     * existed could land a moment AFTER the list that carried it, and overwrite the strip back to not having it.
     * The tab was mounted and then un-listed in the same breath: an empty panel, no wait standing any more (the
     * newer list had already spent it), and a push watching "Nothing runs under that name" while the suite ran.
     *
     * Every ask takes a ticket; an answer is written only if its ticket beats the last one written. So a stale
     * answer is DISCARDED rather than applied, which is the same guarantee without the cost the queue this
     * replaces charged for it.
     *
     * THAT COST WAS A WEDGE, and it is the reason this is not a queue any more. Chaining meant each list was
     * fetched only after the previous one had been APPLIED, so one list that never came back (a paused fetch
     * against a tunnel the browser thinks is offline, which is a request that settles neither way) blocked every
     * relist after it for the life of the panel. The strip then sat on its standing wait forever while the work
     * popover, reading the same shared entry directly, showed the very job it was waiting for as running. */
    let asked = 0;
    let answered = 0;

    /* A LIST THAT WAS REFUSED HAS TO BE ASKED AGAIN, and this is the only place that can.
     *
     * Every other thing that relists reacts to a list that ARRIVED, the daemon's `terminals` frame, the shared
     * entry's content changing, a kill or a spawn. A request that FAILED produces none of those, so the strip
     * simply kept whatever it opened with: on a sandbox switch, that is nothing at all. The panel sat empty over
     * a sandbox whose shells were running the whole time, and the only way back was to make it list by accident:
     * clicking `+`, whose new tab nudges the shared list, at which point every pre-existing terminal appeared.
     *
     * Note what this is NOT: the retry the standing wait replaced (see `focus`) was a race against a session
     * that did not exist YET, and losing it hid the session for good. This asks again because the daemon never
     * answered, a refused request, the first one after a switch, at the moment a resumed daemon is least ready.
     * So the tries are few and spaced, they stop the moment one succeeds, and they never outlive the panel. */
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
            // Nothing more is coming. Said out loud, because a panel that goes on promising terminals it has
            // stopped asking for is the spinner that spins forever.
            answer.value = `refused`;
        }
        // Out of tries, torn down, or already waiting on one, a queue of retries would ask N times over.
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
        // Asked straight away: a caller waiting on this one must never be held up by somebody else's list, and
        // ordering is the tickets' job now rather than a queue's.
        const next = relist();
        // Watched rather than awaited: the caller keeps the promise (and the failure to report), while the retry
        // above is this instance's own business.
        next.then(stopRetrying, retryLater);
        return next;
    };

    // Sandbox switch while mounted: the sessions are already disposed, drop the stale tab state and relist
    // against the new daemon. (createTerminalTabs runs in component setup, so the watcher dies with the surface.)
    watch(epoch, () => {
        order.value = [];
        processes.value = [];
        // The new sandbox's own arrangement, so its splits come back as it left them. No TAB is drawn from it
        // until that sandbox's list lands, `groups` is the intersection, and `order` is empty right now, but
        // the panel does draw its shapes, which is the whole of what `remembered` is for.
        arrangement.value = readGroups();
        // Nothing has been asked of this daemon yet. Ahead of the relist below, so no frame can catch the strip
        // claiming that THIS sandbox has no terminals on the strength of the last one's answer.
        answer.value = `waiting`;
        viewedProcesses.clear();
        // The wait was for a session on the OLD daemon; nothing on this one is going to answer it.
        pending.value = undefined;
        activeName.value = undefined;
        mountedNames = [];
        // A fresh daemon gets fresh tries, whatever the one we just left refused us is spent.
        stopRetrying();
        // And every question still out is void: it was asked of the sandbox we just left, and its answer would
        // otherwise beat the new daemon's own and paint the old machine's sessions onto this one for a beat.
        answered = asked;
        void refresh().catch(() => undefined);
    });

    // The preference toggled while the panel is open (the bar menu, the palette, the Settings row): relist, so
    // the work terminals arrive as tabs, or leave, under the hand that just asked for it. Turning it off drops
    // them from `order` and `groups`; refresh() re-mounts around the survivors if the focused tab was one of
    // them, and their sockets stay parked in the cache in case the user flips back.
    watch(showWorkTerminals, () => {
        // A list that dropped leaves the strip as it was and the retry asks again, nothing to do here, and
        // nobody to tell, so the failure is absorbed rather than left to ride out as an unhandled rejection.
        void refresh()
            .catch(() => undefined)
            .then(() => {
                // Hiding the last tab would leave the panel around a blank pane (only endSession retires it), which
                // is the one case where the strip can empty without a session ending, so it opens a shell instead,
                // the same thing attach() does for an empty panel.
                if (order.value.length === 0 && source.create !== undefined) {
                    newTab();
                }
            });
    });

    // `awaited` is the session the panel was OPENED FOR (Start, Run tests, a capability install, whatever set
    // the focus request that brought the panel up). It suppresses the empty-panel shell: that session's tab is
    // seconds away, and spawning a `web-*` shell to fill the gap puts a stray "1" beside the tab the user
    // actually asked for, plus a real tmux session behind it, for every Start on an otherwise-empty panel.
    const attach = async (el: HTMLElement, awaited?: string): Promise<boolean> => {
        container = el;
        /* A REFUSED FIRST LIST IS NOT THIS CALL'S TO THROW, and swallowing it here is the fix for the worst
         * shape the push bug ever took.
         *
         * Attaching answers exactly one question, did I open the empty panel's shell, and the surface above
         * has more to do once it has that answer, starting with the request that brought the panel up at all.
         * Rethrown, that work was skipped WHOLESALE: a push whose list dropped under the load of its own suite
         * opened a panel that then never went and asked for the check, so the suite ran to completion in a
         * terminal nothing ever showed, behind a strip that quietly retried its way to looking fine.
         *
         * The refusal is already this instance's to report and to ask again about (`answer`, `retryLater`), and
         * a caller has nothing to do with it that those two do not do better. */
        let listed = true;
        await refresh().catch(() => {
            listed = false;
        });
        // Torn down (or re-attached) while the list was in flight, spawning the empty panel's opening shell
        // here would leave a real tmux session nobody asked for and nothing shows, which is how a rapid Ctrl+`
        // used to silt the sandbox up with orphan `web-*` shells. A list that never landed is the same refusal
        // by another route: an empty strip we could not verify is not an empty sandbox, so nothing is created
        // over it, the retry will say what is really running.
        if (container !== el || !listed) {
            return false;
        }
        if (order.value.length === 0 && awaited === undefined && source.create !== undefined) {
            newTab();
            return true;
        }
        return false;
    };

    // Remove the mounted hosts from the DOM without touching any session, sockets, xterms, scrollback stay
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
        // Nobody is left to show the answer to.
        stopRetrying();
    };

    // A session ended (tab ×, or the daemon's exit frame): dispose its client state, drop the tab, focus a
    // neighbour, its own group's survivor first, or hand off to onEmpty when it was the last.
    const endSession = (name: string): void => {
        viewedProcesses.delete(name);
        revealed.delete(name);
        // Waiting on the session that just ended is waiting for nothing.
        if (pending.value === name) {
            pending.value = undefined;
        }
        // Whether or not the daemon ever listed it, this name is spent, a claim left standing would keep the
        // session in the shared list (and in the rail's count) until the page reloaded.
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
        // An empty strip retires the panel however the last tab went, ahead of the mounted check, which only
        // decides whether anything needs REmounting. (A last tab that was never mounted, the panel closed
        // before its list landed, used to leave the panel open around nothing.)
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
        // A non-focused split member died, remount the shrunken group around the still-focused session.
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
            // Focusing IS the explicit open that reveals a hidden work terminal (the chat's Bash card, the
            // work-terminals popover, the Capabilities page's running install), recorded before the relist,
            // which is what decides whether it tabs. Unconditional: the set is only ever consulted for agent/job
            // sessions, so a shell or panel name landing in it changes nothing.
            revealed.add(name);
            /* AND THEN WE WAIT, for as long as it takes. A flow can name its session before tmux has created
             * it, so one look is often too early, but the answer to that used to be a race: eight relists a
             * quarter-second apart, every one of them a round trip, and then silence. Under the load the flow
             * itself makes (a test suite pins the box; plain requests take seconds) those eight tries expire
             * before the session appears, and because a work terminal only tabs when it has been revealed,
             * missing that window did not make the tab LATE, it made it invisible, while the command ran to
             * completion in a terminal nothing ever showed.
             *
             * So the wait is standing instead: the name is remembered, and `refresh` mounts it the moment it
             * is listed. The daemon pushes a `terminals` frame whenever its tmux changes (runtime-watch.ts) and
             * the panel relists on it, so this costs no timer of its own and cannot expire early. One relist
             * still happens now, because the session is usually already there. */
            pending.value = name;
            await refreshTerminals();
            await refresh();
            return;
        }
        // A background-process session never tabs directly, route it through its read-only log view
        // (`panel-docker`, an extension's gateway).
        if (processes.value.some((process) => process.name === name)) {
            await viewProcess(name);
            return;
        }
        mount(name);
    };

    // Make a session that just appeared (the agent's `agent-<id>` the moment it runs Bash) show up as a tab
    // WITHOUT mounting it, refresh() keeps the current active tab, so focus isn't stolen. One relist, and the
    // daemon's own `terminals` frame carries anything that lands after it: this writes the shared session list,
    // which is what makes the work-terminals popover show the turn's shell the moment it starts.
    const surface = async (): Promise<void> => {
        await refresh();
    };

    // Switching away is the "looking up" that ends a finished work terminal's stay: its reveal was held only
    // because it was the tab on screen (see retireFinished). Relist only when that actually let one go, so an
    // ordinary switch between shells still costs nothing.
    const switchTab = (name: string): void => {
        mount(name);
        const held = revealed.size;
        retireFinished(order.value);
        if (revealed.size !== held) {
            void refresh().catch(() => undefined);
        }
    };

    // Programmatic input into the active session, routed through xterm's input handler (fires the same onData
    // that a keystroke does), so the touch extra-keys row reuses the existing socket wiring.
    const sendInput = (data: string): void => {
        const name = activeName.value;
        const session = name === undefined ? undefined : cache.get(name);
        if (session !== undefined) {
            session.term.input(data, true);
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

    // Move one session out of its split group into its own tab, placed right after the group it left.
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
    // Creation is implicit, opening the socket runs `tmux new-session -A`, so for the length of that
    // handshake the daemon does not list the session. The claim (addPendingTerminal) is what carries it across:
    // it counts on the rail the moment the tab appears, and it survives the relists that would otherwise drop
    // the tab out from under a live socket. Retired by endSession, or by the first list that names it.
    // The claim carries a full SESSION, not merely the tab the strip needs: `activityAt` is the one field the
    // daemon would have filled in had it listed this name yet, and it is simply now, the browser created it a
    // moment ago. (Inferred rather than annotated: the query's `TerminalSession` and this module's xterm-side
    // one are different types under the same name.)
    const claim = (name: string): TerminalTab => {
        const tab = { name, kind: `shell` as const, running: true, activityAt: Date.now() };
        addPendingTerminal(tab);
        sessionOf(tab);
        return tab;
    };
    // Open a fresh tab and switch to it.
    const newTab = (): void => {
        const tab = claim(create());
        order.value = [...order.value, tab];
        arrangement.value = [...arrangement.value, [tab.name]];
        persistGroups();
        mount(tab.name);
    };
    // Split the pane: open a fresh shell INSIDE `name`'s group, right after it, and focus it.
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
    // End ONE tab: kill the tmux session for good, then drop its client state. A process log view only hides,
    // stopping a background process is the popover's explicit Stop, never a tab close. The kill runs unawaited:
    // the strip is right immediately (endSession), and the source settles the shared session list once the
    // daemon confirms. Internal on purpose, the published door is `killTabs`, so nothing reaches an
    // irreversible kill by a route the panel's confirm doesn't cover.
    const endTab = (name: string): void => {
        if (!viewedProcesses.has(name)) {
            void kill(name);
        }
        endSession(name);
    };
    // The strip's kill, of one pill or a whole selection, endSession refocuses as the set shrinks.
    const killTabs = (names: string[]): void => {
        for (const name of names) {
            endTab(name);
        }
    };
    // Restart the active shell: kill its session and open a fresh one IN ITS PLACE, same group, same slot,
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
