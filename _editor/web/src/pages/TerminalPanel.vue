<script setup lang="ts">
import { clipboardOf, ui, ConfirmDialog, ContextMenu, Icon, type IconName, Modal, useDevice } from "@intentic/ui";
import type { Disposable } from "@intentic/extension-api";
import type { TerminalScrollback } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import type { MenuItem } from "primevue/menuitem";
import { computed, onBeforeUnmount, onMounted, ref, type VNode, watch } from "vue";
import BackgroundProcesses from "../components/BackgroundProcesses.vue";
import WorkTerminals from "../components/WorkTerminals.vue";
import { commandShortcut, type CommandRegistration, registerCommand, withShortcut } from "../composables/commands/useCommands";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { showWorkTerminals } from "../composables/terminal/useWorkTerminals";
import { KIND_ICONS, setTerminalMeta, TERMINAL_COLORS, TERMINAL_ICONS, type TerminalColor, terminalMeta } from "../composables/terminal/terminalMeta";
import { useTerminalsQuery } from "../composables/terminal/terminalsQuery";
import { fetchScrollback } from "../composables/terminal/terminalScrollback";
import { copySelection, pasteIntoTerminal } from "../composables/terminal/terminalSession";
import { createTerminalTabs, type TerminalTab, type TerminalTabsSource, terminalSessionOf } from "../composables/terminal/useTerminal";
import { clearTerminalRequest, consumeSpawnRequest, registerTerminalSpawn, type TerminalRequest } from "../composables/terminal/useTerminalPanel";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";
import { postTurnControl } from "../composables/chat/turnStream";

/* THE terminal panel — mounted once in the shell, below every view. Each tab is a tmux-backed session in the
 * shared cache (composables/useTerminal): mounting re-appends the active tab's persistent host element,
 * unmounting only detaches it, so scrollback and running processes survive close, navigation, and reload.
 * Tabs arrange into split GROUPS (useTerminal.groups): one pill per group, one segment per session; the
 * active group's sessions render side by side in the pane. The strip is a VSCode-style list: Shift/Ctrl+click
 * multi-selects pills, right-click opens the action menu (split / join / unsplit / kill, and per-terminal
 * rename / color / icon overrides from terminalMeta). Right-click on the bar's empty space opens the same menu
 * on its strip-wide rows alone — kill all, and pop the panel out into its own real window (like the chat
 * strip); the shell owns the teleport. In that window the bar stands up along the LEFT edge — a floating
 * terminal is a tall window, so pills belong on the axis that has room, the way VSCode moves its own terminal
 * list to the side once the panel is wide.
 *
 * The strip lists PLACES — the user's shells and their dev servers. The terminals WORK runs in (an agent's
 * Bash, a capability install) are records of something that already happened, so they tab only while someone is
 * watching and retire themselves when they finish (useWorkTerminals, useTerminal's `revealed`); while they run
 * they are one click away in the toolbar's work-terminals popover. That is why there is no broom here: nothing
 * accumulates in the strip to sweep. Every tab still gets the hover-×, and a stopped dev server keeps its pill
 * — it's a place you restart, not litter. Restart is shell-only (a dev-server tab is re-run via Start, or ↑ at
 * its prompt). Managed background processes (extension gateways, dockerd) never tab by themselves — they live
 * in the toolbar's processes popover, and their × only hides the read-only log view. `initial` is an object so
 * re-requesting the same session still refocuses. Height persists per storageKey; `resizable: false` pins the
 * panel to its container (the mobile route, and the pop-out window). */

const {
    source,
    storageKey,
    initial,
    surfaced,
    resizable = true,
} = defineProps<{
    source: TerminalTabsSource;
    storageKey: string;
    initial?: TerminalRequest;
    // A session to relist as a tab without focusing it (the agent's live terminal — appears without hijacking
    // the active tab). Distinct from `initial`, which focuses.
    surfaced?: { readonly name: string };
    resizable?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const tabs = createTerminalTabs(source, storageKey, () => emit(`close`));
const { order, groups, answer, activeName, switchTab, joinTabs, unsplit, newTab, closeTab, splitTab, killTabs, restart } = tabs;

/* WHAT THE PANEL SHOWS BEFORE IT KNOWS ANYTHING — the shapes of the strip this sandbox was left with.
 *
 * Opening the panel is instant and its terminals are one tunnel round trip away, so there is a moment with
 * nothing to draw. It used to be drawn as "No terminals open." — an answer to a question still in flight, taken
 * back the instant the list landed, and on a slow daemon it was the only thing a returning user saw. The
 * remembered arrangement is the honest alternative: it says how many pills were here and how wide each was,
 * which is exactly a skeleton's claim. Unlabelled and inert on purpose — WHICH terminals came back is the
 * daemon's to say, and a placeholder that named one would be a promise this panel cannot keep.
 *
 * Capped, because the shapes are decoration: a sandbox left with twenty splits should not spend two rows of the
 * strip on furniture. */
const PLACEHOLDER_LIMIT = 6;
const placeholders = computed(() =>
    answer.value === `waiting` && groups.value.length === 0 ? tabs.remembered.value.slice(0, PLACEHOLDER_LIMIT) : [],
);
// Restart kills the active session and opens a fresh web-* shell in its slot — meaningless for a dev-server
// tab, which gets refresh instead.
const activeShell = computed(() => order.value.find((tab) => tab.name === activeName.value)?.kind === `shell`);
const popout = useTerminalPopout();
// The bar turns into a left rail while the panel floats in its own window (see the component comment).
const vertical = computed(() => popout.poppedOut.value);
// Teleporting the panel to/from the pop-out window moves the container wholesale without any Vue re-mount —
// remount the active group after the flush so every cell refits (and the PTYs resync) at the new window's size.
watch(
    popout.poppedOut,
    () => {
        if (activeName.value !== undefined) {
            switchTab(activeName.value);
        }
    },
    { flush: `post` },
);

// Sessions FINISH through paths no client action fires: an agent's last Bash command exits, a dev server dies.
// The strip lists imperatively (around spawns, kills, restarts and surfaces), so a tab would keep reading as
// running — undimmed, and invisible to the sweep below — until the panel was reopened or refreshed by hand.
// Observing the shared entry (the same one the rail's badge reads, and the one the strip's own relists write)
// supplies the missing edge. Relisting only when the daemon's session set actually changes keeps it to one
// reconcile per real change, and that relist is served from the cache it just reacted to rather than costing a
// second request.
const listed = useTerminalsQuery();
watch(
    () => listed.sessions.value.map((session) => `${session.name}:${session.running}`).join(`\n`),
    // Absorbed: a dropped list is the strip's own to report and to ask again about, and a reaction nobody
    // awaits is the one place a throw goes nowhere but the console.
    () => void tabs.refresh().catch(() => undefined),
);

/* AND THE DAEMON COMING BACK IS ITSELF A RELIST — for an outage that outlasts asking again.
 *
 * A list refused on the way in re-asks a few times on its own (useTerminal's refresh), which covers the seconds
 * a resumed daemon takes to answer. An outage measured in minutes outlives that, and the watch above cannot end
 * it either: it reacts to the session set CHANGING, and a daemon nobody can reach reports no changes. So the
 * moment this one is reachable again, the strip asks once more — the cheapest possible answer to "was anything
 * running while we were cut off". */
watch(useSandbox().reachable, (isReachable) => {
    if (isReachable) {
        void tabs.refresh().catch(() => undefined);
    }
});

/* THE AGENT IS WAITING FOR YOU AT THIS TERMINAL — the answering end of the terminal handover
 * (sandbox terminal/terminal-help.ts), and the exact counterpart of the banner over the Browsers stage.
 *
 * The ask rides the terminals list, so it needs no state of its own here: whichever session the strip has
 * ACTIVE is the one whose banner shows, and it comes down when the daemon publishes the cleared flag — the
 * same push that raised it. That the banner follows the active tab rather than shouting from wherever it was
 * raised is the whole reason it belongs here: the thing the owner has to answer is the prompt in the pane
 * directly below it, and an ask floating over a different session's pane would be pointing at nothing.
 *
 * An ask on a tab that is NOT active still reaches the owner — the chat card and the phone notification both
 * carry it, and the card's button focuses this very tab.
 */
const help = computed(() => listed.sessions.value.find((session) => session.name === activeName.value)?.help);
const helpNote = ref(``);
watch(activeName, () => (helpNote.value = ``));
const resolveHelp = async (helped: boolean): Promise<void> => {
    const open = help.value;
    if (open === undefined) {
        return;
    }
    const note = helpNote.value.trim();
    await postTurnControl(`/agent/reply`, { kind: `terminal_help`, requestId: open.requestId, helped, ...(note === `` ? {} : { note }) });
    helpNote.value = ``;
};

// --- Tab strip: segments, numbering, cosmetics ------------------------------------------------
const tabByName = computed(() => new Map(order.value.map((tab) => [tab.name, tab])));
// Unlabeled shells show their 1-based position in the strip's reading order (across groups).
const stripIndex = computed(() => {
    const index = new Map<string, number>();
    let position = 0;
    for (const group of groups.value) {
        for (const name of group) {
            position += 1;
            index.set(name, position);
        }
    }
    return index;
});
// What the pop-out button says and is named, both directions — the same wording as the strip menu's row and the
// palette's, with the chord when one is bound (withShortcut, shared with the chat strip's own button).
const popoutHint = computed(() => withShortcut(popout.poppedOut.value ? `Dock panel back` : `Move panel into new window`, `terminal.togglePopout`));
// The panel's dismissal, which is NOT a kill — the sessions are tmux facts on the sandbox and outlive every view
// of them. It used to say "Close terminal" under a ×, the same glyph the pills carry for the one action that
// DOES end a session, so the toolbar read as "kill everything". It now says what it does and leaves × to the
// pills: docked, the panel drops back down to its dock (chevron-down, pointing where it goes); floating, there
// is nothing to drop into and the press retires the window, which is the one place a × still tells the truth.
const closeHint = computed(() =>
    withShortcut(
        popout.poppedOut.value ? `Close the window — the terminals keep running` : `Hide the panel — the terminals keep running`,
        `terminal.toggle`,
    ),
);
const segmentIcon = (name: string): IconName => terminalMeta(name).icon ?? KIND_ICONS[tabByName.value.get(name)?.kind ?? `shell`];
const segmentColor = (name: string): string | undefined => {
    const color = terminalMeta(name).color;
    return color === undefined ? undefined : TERMINAL_COLORS[color];
};
const segmentLabel = (name: string): string =>
    terminalMeta(name).label ?? tabByName.value.get(name)?.label ?? String(stripIndex.value.get(name) ?? ``);
const segmentTooltip = (name: string): string | undefined => {
    const tab = tabByName.value.get(name);
    if (tab === undefined) {
        return undefined;
    }
    if (tab.kind === `agent`) {
        return tab.running === false ? `AI terminal — finished` : `AI terminal`;
    }
    if (tab.kind === `job`) {
        return `Job terminal`;
    }
    if (tab.kind === `process`) {
        return `Background process — read-only logs`;
    }
    return tab.running === false ? `finished` : undefined;
};

// --- Multi-selection (VSCode's terminal list): Shift extends, Ctrl toggles, plain click activates ----------
// Selection is per-GROUP (pills), keyed by each group's first session name; it only feeds the context menu's
// mass actions (join / kill), so any structural change just clears it.
const selectedKeys = ref<string[]>([]);
const anchor = ref<number | undefined>(undefined);
const groupKey = (group: string[]): string => group[0] ?? ``;
const isSelected = (group: string[]): boolean => selectedKeys.value.includes(groupKey(group));
const selectedGroups = computed(() => groups.value.filter((group) => isSelected(group)));
// Flattened in strip order, so joined panes read the same left-to-right as the strip did.
const selectedNames = computed(() => selectedGroups.value.flat());
const activeGroupIndex = computed(() => groups.value.findIndex((group) => activeName.value !== undefined && group.includes(activeName.value)));

const onSegmentClick = (event: MouseEvent, groupIndex: number, name: string): void => {
    if (event.shiftKey) {
        const from = anchor.value ?? (activeGroupIndex.value === -1 ? groupIndex : activeGroupIndex.value);
        const [lo, hi] = from < groupIndex ? [from, groupIndex] : [groupIndex, from];
        selectedKeys.value = groups.value.slice(lo, hi + 1).map(groupKey);
        return;
    }
    if (event.ctrlKey || event.metaKey) {
        const key = groupKey(groups.value[groupIndex] ?? []);
        selectedKeys.value = isSelected(groups.value[groupIndex] ?? []) ? selectedKeys.value.filter((k) => k !== key) : [...selectedKeys.value, key];
        anchor.value = groupIndex;
        return;
    }
    selectedKeys.value = [];
    anchor.value = groupIndex;
    switchTab(name);
};

// --- Killing in bulk ---------------------------------------------------------------------------
// `killable` is what "all terminals" means: every session EXCEPT a background process's log view, whose
// lifecycle belongs to the processes popover (the sweep above draws the same line, and for the same reason —
// killing one there would be a no-op that lied about the count).
//
// A bulk kill ENDS whatever those sessions are running, so it stops at a confirm listing the live ones. That is
// the rule the other two strips already follow — the chat's "stop N running agents?", the workspace's
// unsaved-edits dialog. A single × (and the menu's "Kill terminal") stays silent: that pill is under the
// pointer, the one being killed.
const killable = computed(() => order.value.filter((tab) => tab.kind !== `process`).map((tab) => tab.name));
const pendingKill = ref<string[]>();
const runningIn = (names: string[]): TerminalTab[] => order.value.filter((tab) => names.includes(tab.name) && tab.running);
const pendingKillRunning = computed(() => (pendingKill.value === undefined ? [] : runningIn(pendingKill.value)));
const requestKill = (names: string[]): void => {
    if (killTabs === undefined || names.length === 0) {
        return;
    }
    // One session is the single-kill case however it was reached — a lone selected pill, or "kill all" with one
    // terminal left. It is on screen and named in the gesture, so it goes without a dialog.
    if (names.length === 1 || runningIn(names).length === 0) {
        killTabs(names);
        selectedKeys.value = [];
        return;
    }
    pendingKill.value = names;
};
const confirmKill = (): void => {
    if (pendingKill.value !== undefined) {
        killTabs?.(pendingKill.value);
        selectedKeys.value = [];
    }
    pendingKill.value = undefined;
};

// --- Rename (inline, in the strip) -------------------------------------------------------------
// The pill's label edits IN PLACE — the same gesture as a chat tab and a workspace-tree file, and for the same
// reason: renaming is a one-field edit of something already on screen, so a modal that hides the strip it
// renames is pure ceremony. Enter commits, Esc cancels, blur commits, and an EMPTY name clears the override
// back to the default label (that's the reset, hence no silent-cancel-on-empty here).
const renamingName = ref<string | undefined>(undefined);
const renameDraft = ref(``);
const beginRename = (name: string): void => {
    renameDraft.value = terminalMeta(name).label ?? ``;
    renamingName.value = name;
};
const commitRename = (): void => {
    const name = renamingName.value;
    renamingName.value = undefined;
    if (name === undefined) {
        return; // Enter already committed; the input's unmount blur must not commit again
    }
    const trimmed = renameDraft.value.trim();
    setTerminalMeta(name, { label: trimmed === `` ? undefined : trimmed });
};
const cancelRename = (): void => {
    renamingName.value = undefined;
};
// Focus + select the field the moment it mounts (the @vue:mounted trick, see WorkspaceTree).
const focusRename = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
};
// The default label a cleared name falls back to — the input's placeholder, so "empty resets" is visible.
const defaultLabel = (name: string): string => tabByName.value.get(name)?.label ?? `Terminal ${stripIndex.value.get(name) ?? ``}`;

// --- Color / icon (per-terminal overrides, terminalMeta) ---------------------------------------
// These two stay in a dialog: a swatch grid is a picker, not a text field, and it has nowhere to live in a
// 6px-tall pill.
const customize = ref<{ name: string; mode: `color` | `icon` } | undefined>(undefined);
const openCustomize = (name: string, mode: `color` | `icon`): void => {
    customize.value = { name, mode };
};
const applyColor = (color: TerminalColor | undefined): void => {
    if (customize.value === undefined) {
        return;
    }
    setTerminalMeta(customize.value.name, { color });
    customize.value = undefined;
};
const applyIcon = (icon: IconName | undefined): void => {
    if (customize.value === undefined) {
        return;
    }
    setTerminalMeta(customize.value.name, { icon });
    customize.value = undefined;
};
const colorOptions = Object.entries(TERMINAL_COLORS) as [TerminalColor, string][];
const customizeHeader = computed(() =>
    customize.value === undefined ? `` : { color: `Terminal color`, icon: `Terminal icon` }[customize.value.mode],
);

// --- Context menu (right-click a pill) ---------------------------------------------------------
const menu = ref<{ show: (event: Event) => void } | undefined>();
const menuTarget = ref<{ groupIndex: number; name: string } | undefined>(undefined);
const openTabMenu = (event: MouseEvent, groupIndex: number, name: string): void => {
    const group = groups.value[groupIndex] ?? [];
    // Right-click outside the current selection retargets it (VSCode's list behavior).
    if (!isSelected(group)) {
        selectedKeys.value = [groupKey(group)];
        anchor.value = groupIndex;
    }
    menuTarget.value = { groupIndex, name };
    menu.value?.show(event);
};

// The rows that name no particular pill: the strip-wide kills, the sweep, and the pop-out toggle. They tail
// whichever branch of the pill menu is showing AND they are the whole of the menu a right-click on the bar's
// empty space opens — the same pair of entry points the chat and workspace strips give their Close All. Each
// row is absent when it would be a no-op, so the menu never offers one.
const stripItems = computed<MenuItem[]>(() => {
    const items: MenuItem[] = [];
    if (killTabs !== undefined && killable.value.length > 0) {
        items.push({ label: `Kill all terminals`, shortcut: commandShortcut(`terminal.killAll`), command: () => requestKill(killable.value) });
    }
    items.push(
        ...(items.length > 0 ? [{ separator: true }] : []),
        // The one CHECKED row in this menu (see the #item slot's checkmark gutter): whether the terminals work
        // runs in tab here at all. It sits where the annoyance is felt — a right-click on the strip they were
        // crowding — and writes the same preference as the work popover's footer and Settings → Appearance.
        {
            label: `Show work terminals`,
            checked: showWorkTerminals.value,
            shortcut: commandShortcut(`terminal.toggleWorkTerminals`),
            command: () => (showWorkTerminals.value = !showWorkTerminals.value),
        },
        {
            label: popout.poppedOut.value ? `Dock panel back` : `Move panel into new window`,
            shortcut: commandShortcut(`terminal.togglePopout`),
            command: popout.toggle,
        },
    );
    return items;
});

const menuItems = computed<MenuItem[]>(() => {
    const target = menuTarget.value;
    if (target === undefined) {
        return stripItems.value;
    }
    const { name } = target;
    const group = groups.value[target.groupIndex] ?? [name];
    // A multi-selection gets the mass actions; a single pill gets the per-terminal ones. Each item carries its
    // command's effective shortcut (commandShortcut) so the menu teaches the key — right-aligned via #item.
    if (selectedGroups.value.length > 1) {
        const names = selectedNames.value;
        const items: MenuItem[] = [
            {
                label: `Join ${selectedGroups.value.length} tabs`,
                shortcut: commandShortcut(`terminal.join`),
                command: () => {
                    joinTabs(names);
                    selectedKeys.value = [];
                },
            },
        ];
        if (killTabs !== undefined) {
            items.push(
                { separator: true },
                { label: `Kill ${names.length} terminals`, shortcut: commandShortcut(`terminal.kill`), command: () => requestKill(names) },
            );
        }
        return [...items, ...stripItems.value];
    }
    const items: MenuItem[] = [];
    if (splitTab !== undefined) {
        items.push({ label: `Split terminal`, shortcut: commandShortcut(`terminal.split`), command: () => splitTab(name) });
    }
    if (group.length > 1) {
        items.push({ label: `Unsplit terminal`, shortcut: commandShortcut(`terminal.unsplit`), command: () => unsplit(name) });
    }
    if (items.length > 0) {
        items.push({ separator: true });
    }
    items.push(
        { label: `Rename`, shortcut: commandShortcut(`terminal.rename`), command: () => beginRename(name) },
        { label: `Change color…`, shortcut: commandShortcut(`terminal.changeColor`), command: () => openCustomize(name, `color`) },
        { label: `Change icon…`, shortcut: commandShortcut(`terminal.changeIcon`), command: () => openCustomize(name, `icon`) },
    );
    if (closeTab !== undefined) {
        items.push(
            { separator: true },
            {
                label: tabByName.value.get(name)?.kind === `process` ? `Close log view` : `Kill terminal`,
                shortcut: commandShortcut(`terminal.kill`),
                command: () => closeTab(name),
            },
        );
    }
    return [...items, ...stripItems.value];
});

// --- Full scrollback ---------------------------------------------------------------------------
// The pane's history as plain text, which is the only form of it the browser can select. `pending` is its own
// state rather than a spinner over stale text: a capture of tens of thousands of lines crosses the tunnel, and
// showing the PREVIOUS terminal's scrollback while the next one loads would be the worst possible lie here.
const scrollback = ref<TerminalScrollback | undefined>(undefined);
const scrollbackName = ref<string | undefined>(undefined);
const scrollbackFailed = ref(false);
const scrollbackPending = computed(() => scrollbackName.value !== undefined && scrollback.value === undefined && !scrollbackFailed.value);
const scrollbackText = ref<HTMLElement>();

const openScrollback = async (name: string): Promise<void> => {
    scrollbackName.value = name;
    scrollback.value = undefined;
    scrollbackFailed.value = false;
    try {
        const captured = await fetchScrollback(name);
        // Superseded while in flight — the dialog was closed, or another terminal was asked for.
        if (scrollbackName.value === name) {
            scrollback.value = captured;
        }
    } catch {
        // The session ended between the right-click and the read, or the daemon went away. The dialog says so
        // rather than sitting on a spinner forever.
        if (scrollbackName.value === name) {
            scrollbackFailed.value = true;
        }
    }
};

const closeScrollback = (): void => {
    scrollbackName.value = undefined;
    scrollback.value = undefined;
    scrollbackFailed.value = false;
};

// Through the dialog's own element, so a popped-out panel writes from the window the user is actually in.
const copyScrollback = (): void => {
    const text = scrollback.value?.text;
    if (text !== undefined) {
        void clipboardOf(scrollbackText.value).writeText(text);
    }
};

// --- Context menu (right-click the GRID) -------------------------------------------------------
// Right-click inside a terminal used to reach tmux, whose default binding drew its OWN pane menu over the
// output — splits, swap, kill, respawn: a menu about tmux's panes, in an app whose panes are the strip above,
// positioned at the pane's idea of the pointer. Those bindings are gone from the image's tmux.conf, so the
// gesture lands here, on what a terminal actually owes a browser: the clipboard, and the scrollback the
// alternate screen hides.
//
// It targets the session UNDER THE POINTER, not the focused one — in a split those differ, and a menu that
// copied from the other pane would be a quiet wrong answer.
const gridMenu = ref<{ show: (event: Event) => void } | undefined>();
const gridTarget = ref<string | undefined>(undefined);
// Sampled at open, not read live: `disabled` is evaluated as the menu renders, and xterm clears the selection
// when the terminal loses focus to it.
const gridHasSelection = ref(false);

const onGridContextMenu = (event: MouseEvent): void => {
    const cell = event.target instanceof Element ? event.target.closest<HTMLElement>(`.term-cell`) : null;
    const name = cell?.dataset[`session`];
    if (name === undefined || terminalSessionOf(name) === undefined) {
        return;
    }
    event.preventDefault();
    gridTarget.value = name;
    gridHasSelection.value = terminalSessionOf(name)?.term.hasSelection() === true;
    gridMenu.value?.show(event);
};

const gridItems = computed<MenuItem[]>(() => {
    const name = gridTarget.value;
    const session = name === undefined ? undefined : terminalSessionOf(name);
    if (name === undefined || session === undefined) {
        return [];
    }
    // Copy and Paste carry no shortcut hint: Ctrl+Shift+C/V are the browser's own (DevTools, paste-as-text) and
    // this panel deliberately binds neither — plain Ctrl+V already pastes, because it arrives as the textarea
    // paste event xterm listens for.
    const items: MenuItem[] = [
        { label: `Copy`, disabled: !gridHasSelection.value, command: () => copySelection(session) },
        { label: `Paste`, command: () => pasteIntoTerminal(session) },
        { separator: true },
        { label: `Full scrollback…`, command: () => void openScrollback(name) },
    ];
    if (splitTab !== undefined) {
        items.push({ separator: true }, { label: `Split terminal`, shortcut: commandShortcut(`terminal.split`), command: () => splitTab(name) });
    }
    return items;
});

// --- Panel geometry ----------------------------------------------------------------------------
// Persisted per surface. Height is clamped to a floor and ~80% of the viewport. There is no collapsed state:
// the toolbar's × closes the panel outright, and closing already only unmounts it — every session keeps
// streaming in the shared cache — so a second, half-shut state was a control that did the same thing worse.
const HEIGHT_KEY = `ui-${storageKey}-terminal-height`;
const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 96;
const clampHeight = (px: number): number => Math.round(Math.max(MIN_HEIGHT, Math.min(px, window.innerHeight * 0.8)));
const readHeight = (): number => {
    try {
        const parsed = Number.parseInt(localStorage.getItem(HEIGHT_KEY) ?? ``, 10);
        return Number.isFinite(parsed) ? clampHeight(parsed) : DEFAULT_HEIGHT;
    } catch {
        return DEFAULT_HEIGHT;
    }
};
const write = (key: string, value: string): void => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

const root = ref<HTMLElement>();
const height = ref(readHeight());
const setHeight = (px: number): void => {
    height.value = clampHeight(px);
    write(HEIGHT_KEY, String(height.value));
};

// Alt+PageDown/PageUp walk the strip in READING order — every session, splits included, not just one pill at a
// time — wrapping at the ends. The chord is the shell-wide one; see the command entries below.
const cycleTab = (delta: number): void => {
    const names = groups.value.flat();
    if (names.length < 2) {
        return;
    }
    const index = names.findIndex((name) => name === activeName.value);
    const next = names[(index + delta + names.length) % names.length];
    if (next !== undefined) {
        switchTab(next);
    }
};

// --- Palette commands + shortcuts --------------------------------------------------------------
// Every strip action is also a registered command, so it lives in `>` (Ctrl+P) and on a shortcut. Registered
// while THIS panel is mounted (the desktop shell and the mobile route are exclusive, so the ids can't
// double-register) and disposed on unmount. Join and kill are selection-aware; the rest act on the focused
// session.
//
// The commands split in two. The TAB family — kill, kill all, next/previous, rename — takes the shell-wide
// chords the workspace's file tabs and the chat's strip also register (Ctrl+Shift+X, Ctrl+Shift+Backspace,
// Alt+PageUp/PageDown, F2), each gated to a keystroke from inside THIS panel so focus decides which of the three
// strips a press reaches (tabSurface.ts). One chord per verb beats three chords memorized, and it is what F2
// has always done here. The panel's OWN verbs — split, unsplit, join — have no counterpart on the other strips,
// so they keep private chords and stay ungated (splitting the focused terminal from the editor is useful).
//
// The chorded defaults are all Ctrl+Shift+<key> — the ONE modifier family that's safe here, for two independent
// reasons: (1) the shell owns every Ctrl+<letter> (C/D/R/U/K/W/A/E… — SIGINT, EOF, reverse-search, readline
// line-edits), and Shift makes a DISTINCT keydown, so createTerminalSession's handler swallows only the exact
// bound chord and leaves the bare control code untouched; (2) it dodges Ctrl+Alt, which is AltGr on
// Windows/Linux (types € @ … and international glyphs) and an ESC-prefixed control code in a terminal — the
// trap the old Ctrl+Alt+{R,J,U} defaults fell into. Letters steer clear of the browser chords the page can't
// intercept (Ctrl+Shift+{I,J,C}=DevTools, N=incognito, T=reopen tab, W=close window, C/V=terminal copy/paste),
// and lean mnemonic: U=unsplit, G=group(join). Split keeps Ctrl+Shift+5 and New keeps
// Ctrl+Shift+` — the VSCode/tmux muscle memory — matched by physical key (matchesChord's CODE_TO_KEY path), so
// the Shift glyph ("%","~"), a dead-key layout, or a non-US layout can't break them. Everything is rebindable
// in Settings → Keybindings — per surface, so remapping Kill Terminal leaves Close Tab alone; the two cosmetic
// pickers (color, icon) ship UNBOUND — a global chord for a rare "open a swatch grid" earns its keys the least,
// so they stay palette- and menu-only, exactly as VSCode leaves them (double-click a tab renames without one).
// "New Terminal" is NOT here: it registers globally (useShellCommands) so it works with the panel closed,
// routed through useTerminalPanel's spawn hook.
let commandDisposables: readonly Disposable[] = [];
const registerPanelCommands = (): void => {
    const entries: Omit<CommandRegistration, `owner`>[] = [
        {
            command: `terminal.rename`,
            title: `Rename Terminal`,
            icon: `pencil`,
            // F2 — the rename key everywhere else in the app (the workspace tree's, the chat strip's) — gated to
            // a keystroke that came from INSIDE this panel. Outside it the chord stays free (the tree renames
            // its file, a full-screen TUI in another surface keeps F2), and inside it the gate is what makes
            // xterm's key hook forward the press to the dispatcher instead of the PTY: a terminal app that wants
            // its own F2 needs the binding remapped in Settings → Keybindings.
            keybinding: `F2`,
            when: `tabSurface == 'terminal'`,
            handler: (): void => {
                if (renamingName.value !== undefined) {
                    return; // already editing (F2 lands in the field) — restarting would wipe the draft
                }
                if (activeName.value !== undefined) {
                    beginRename(activeName.value);
                }
            },
        },
        {
            command: `terminal.changeColor`,
            title: `Change Terminal Color…`,
            icon: `palette`,
            handler: (): void => {
                if (activeName.value !== undefined) {
                    openCustomize(activeName.value, `color`);
                }
            },
        },
        {
            command: `terminal.changeIcon`,
            title: `Change Terminal Icon…`,
            icon: `star`,
            handler: (): void => {
                if (activeName.value !== undefined) {
                    openCustomize(activeName.value, `icon`);
                }
            },
        },
        {
            command: `terminal.join`,
            title: `Join Selected Terminals`,
            icon: `code`,
            keybinding: `Ctrl+Shift+G`,
            handler: (): void => {
                if (selectedGroups.value.length > 1) {
                    joinTabs(selectedNames.value);
                    selectedKeys.value = [];
                }
            },
        },
        {
            command: `terminal.unsplit`,
            title: `Unsplit Terminal`,
            icon: `code`,
            keybinding: `Ctrl+Shift+U`,
            handler: (): void => {
                if (activeName.value !== undefined) {
                    unsplit(activeName.value);
                }
            },
        },
        {
            // Unbound by default, like the cosmetic pickers: flipping a preference is a once-in-a-while act, and
            // it already has two clickable homes (the bar menu, the popover footer).
            command: `terminal.toggleWorkTerminals`,
            title: `Toggle Work Terminals in Panel`,
            icon: `sparkles`,
            handler: (): void => {
                showWorkTerminals.value = !showWorkTerminals.value;
            },
        },
        {
            command: `terminal.nextTab`,
            title: `Next Terminal`,
            keybinding: `Alt+PageDown`,
            when: `tabSurface == 'terminal'`,
            handler: () => cycleTab(1),
        },
        {
            command: `terminal.previousTab`,
            title: `Previous Terminal`,
            keybinding: `Alt+PageUp`,
            when: `tabSurface == 'terminal'`,
            handler: () => cycleTab(-1),
        },
    ];
    if (splitTab !== undefined) {
        entries.push({
            command: `terminal.split`,
            title: `Split Terminal`,
            icon: `code`,
            keybinding: `Ctrl+Shift+5`,
            handler: (): void => {
                if (activeName.value !== undefined) {
                    splitTab(activeName.value);
                }
            },
        });
    }
    if (closeTab !== undefined) {
        entries.push({
            command: `terminal.kill`,
            title: `Kill Terminal`,
            icon: `trash`,
            keybinding: `Ctrl+Shift+X`,
            when: `tabSurface == 'terminal'`,
            handler: (): void => {
                // A selection is what the chord aims at when there is one (the menu's mass row does the same);
                // requestKill is what turns two or more live sessions into a confirm.
                if (killTabs !== undefined && selectedNames.value.length > 0) {
                    requestKill(selectedNames.value);
                    return;
                }
                if (activeName.value !== undefined) {
                    closeTab(activeName.value);
                }
            },
        });
    }
    if (killTabs !== undefined) {
        entries.push({
            command: `terminal.killAll`,
            title: `Kill All Terminals`,
            icon: `trash`,
            keybinding: `Ctrl+Shift+Backspace`,
            when: `tabSurface == 'terminal'`,
            handler: () => requestKill(killable.value),
        });
    }
    commandDisposables = entries.map((entry) => registerCommand({ owner: `builtin`, ...entry }));
};

// Right-click on the bar's EMPTY space (not a pill, not a button) OPENS THE MENU on its strip-wide rows — kill
// all, sweep the finished, pop the panel out. It used to pop out on the spot, which turned a right-click that
// merely missed a pill into a whole floating window; the pop-out is a row in the menu now, exactly as on the
// chat strip.
const onBarContextMenu = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(`button, .tterm`) !== null) {
        return;
    }
    event.preventDefault();
    menuTarget.value = undefined;
    menu.value?.show(event);
};

// --- Touch extra-keys row --------------------------------------------------------------------
// A soft keyboard has no Esc/Tab/Ctrl/arrows; on coarse pointers a scrollable row supplies them, injecting
// escape sequences straight into the active session. Desktop never renders it.
const { coarse } = useDevice();

// The control code for a printable char (c → \x03, d → \x04, …); non-letters pass through.
const controlCode = (ch: string): string => {
    const code = ch.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : ch;
};

// Ctrl is sticky: arm it, then the next printable keydown (from the soft keyboard) is sent as its control code
// — the only reliable way to reach Ctrl+C/D/Z without a physical modifier. Best-effort: some Android keyboards
// emit no usable keydown, in which case Ctrl just disarms on the next tap. ponytail: no visual affordance for
// which key it will modify beyond the armed tint.
const ctrlArmed = ref(false);
const onArmedKeydown = (event: KeyboardEvent): void => {
    if (event.key.length !== 1) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    tabs.sendInput(controlCode(event.key));
    ctrlArmed.value = false;
};
watch(ctrlArmed, (armed) => {
    if (armed) {
        window.addEventListener(`keydown`, onArmedKeydown, true);
    } else {
        window.removeEventListener(`keydown`, onArmedKeydown, true);
    }
});

const EXTRA_KEYS: readonly { label: string; data: string }[] = [
    { label: `Esc`, data: `\x1b` },
    { label: `Tab`, data: `\t` },
    { label: `/`, data: `/` },
    { label: `-`, data: `-` },
    { label: `|`, data: `|` },
    { label: `~`, data: `~` },
    { label: `↑`, data: `\x1b[A` },
    { label: `↓`, data: `\x1b[B` },
    { label: `←`, data: `\x1b[D` },
    { label: `→`, data: `\x1b[C` },
];
// pointerdown (not click) with preventDefault: keep the xterm textarea focused so the soft keyboard stays up.
const pressKey = (data: string): void => tabs.sendInput(data);

const container = ref<HTMLElement>();

// The spawn-hook disposer. Registered synchronously at mount — ahead of the initial relist, not behind it:
// attach() takes the container before it awaits anything, so the hook is usable the moment it is published,
// and a relist that REJECTS (an unreachable daemon, or one whose session list predates the contract the app
// parses it with) must not take "New Terminal" down with it. Behind the await, one bad list left the command a
// no-op that opened the panel and never spawned anything, for as long as that panel lived.
let disposeSpawn: (() => void) | undefined;
// The panel is torn down and reopened by a plain v-if (Ctrl+`, the ×), so the initial relist can easily outlive
// its own instance. Everything after that await has to check: running a dead instance's newTab opens a real
// tmux session that no live panel will ever show.
let live = true;

/* WHAT THE PANEL IS WAITING FOR, and what it may say about it. `tabs.pending` is the wait itself — held until
 * the session is listed, however long that takes (useTerminal's focus) — and this is the sentence that goes
 * with it, kept from the request that started the wait.
 *
 * The wait used to be a bounded race whose only vocabulary was the session name, so a push met a spinner over
 * `job-checks` and no way to find out what that was. Two things fix that: the request carries a title, and the
 * wait ADMITS DEFEAT out loud — `waited` below flips after a few seconds, the panel stops holding itself empty
 * for a tab that isn't coming, and says what it was waiting for instead of spinning on it forever. */
const about = ref<TerminalRequest | undefined>(initial);
const awaiting = computed(() => tabs.pending.value);
// How long the panel holds itself empty for a session on its way. Long enough to cover a slow start under the
// load the flow itself makes (a suite pins the sandbox, and the daemon answers in seconds), short enough that
// nobody sits in front of a spinner wondering whether anything is happening at all.
const WAIT_MS = 6_000;
const waited = ref(false);
let waitTimer: ReturnType<typeof setTimeout> | undefined;
watch(
    awaiting,
    (name) => {
        clearTimeout(waitTimer);
        waited.value = false;
        if (name !== undefined) {
            waitTimer = setTimeout(() => (waited.value = true), WAIT_MS);
        }
    },
    { immediate: true },
);

// What the panel says about itself while it has nothing to show. A caller that named what it started gets its
// own sentence; everything else falls back to the session name, drawn as the id it is.
const named = computed(() => awaiting.value ?? about.value?.name ?? ``);
const emptyHint = computed(() => {
    if (awaiting.value !== undefined) {
        // The wait is still standing — it has only stopped holding the panel empty. Saying so is the difference
        // between "be patient" and the spinner that used to sit there with nothing behind it.
        return `No terminal has appeared for it yet. It may still be starting, and this panel will show it the moment it does.`;
    }
    if (answer.value === `refused`) {
        // The one case where the panel knows it is not the sandbox that is empty, but the asking that failed.
        return `This sandbox didn't answer when asked what it was running. Anything already going is still going — try again from the refresh button.`;
    }
    return about.value === undefined
        ? `Open one to run something here.`
        : `Nothing in this sandbox runs under that name — it was started outside it, or it has already stopped.`;
});

/* Take the request — and SPEND it. It stands in module state so that setting it can open a panel that isn't
 * mounted yet; left standing afterwards, the next panel to mount replayed it, which is how a terminal from a
 * push half an hour ago came back as "Opening job-checks…" over an empty panel. */
const openRequested = async (request: TerminalRequest): Promise<void> => {
    about.value = request;
    clearTerminalRequest();
    // A list that dropped on the way is NOT a failed open: `focus` records the standing wait BEFORE it asks
    // anything, so the tab still arrives whenever the session does. Absorbed because the alternative is an
    // unhandled rejection out of a watcher, over a thing that is already recovering by itself.
    await tabs.focus(request.name).catch(() => undefined);
};

onMounted(async () => {
    registerPanelCommands();
    const pane = container.value;
    if (pane === undefined) {
        // Nothing to attach to, so nothing asked of this panel can be honoured. Both requests are MODULE state
        // though, and one left standing is not held for its asker — it is handed to whatever unrelated thing
        // mounts a panel next. So they are spent here, where they died.
        consumeSpawnRequest();
        clearTerminalRequest();
        return;
    }
    // `initial` at mount means the panel was opened FOR that session (Start, Run tests, a capability install) —
    // attach skips the empty-panel shell for it, so the asked-for tab arrives alone instead of behind a stray
    // `web-*` "1" that filled the second before the daemon's session existed.
    const attaching = tabs.attach(pane, initial?.name);
    if (newTab !== undefined) {
        disposeSpawn = registerTerminalSpawn(newTab);
    }
    const autoCreated = await attaching;
    /* THE SPAWN REQUEST IS SPENT BY THIS MOUNT, WHATEVER THIS MOUNT MANAGES TO DO WITH IT — so it is read
     * before any decision, never from behind a `&&` that can skip reading it.
     *
     * A "New Terminal" pressed with no panel mounted stands in module state until a panel takes it. Left there
     * by a mount that raced a Ctrl+` (`live` false by the time we get here), it does not go back to that press:
     * it lies in wait and opens a shell into whatever brings a panel up next — which is the stray "1" that
     * turns up beside a push's checks, minutes or hours later.
     *
     * An empty panel's auto-created shell IS that terminal, so it is never opened twice. */
    const spawnAsked = consumeSpawnRequest();
    if (live && newTab !== undefined && spawnAsked && !autoCreated) {
        newTab();
    }
    if (live && initial !== undefined) {
        await openRequested(initial);
    }
});
onBeforeUnmount(() => {
    live = false;
    clearTimeout(waitTimer);
    tabs.detach();
    window.removeEventListener(`keydown`, onArmedKeydown, true);
    for (const disposable of commandDisposables) {
        disposable.dispose();
    }
    commandDisposables = [];
    disposeSpawn?.();
    disposeSpawn = undefined;
});
// A parent-driven focus request (a row's terminal button while the panel is already open) — a fresh object per
// request, so the same session refocuses too.
watch(
    () => initial,
    (request) => {
        if (request !== undefined) {
            void openRequested(request);
        }
    },
);
// A parent-driven surface request (the agent started running Bash) — relist so the tab appears, without
// focusing it. Only meaningful while the panel is mounted; a closed panel lists the session on its next open.
watch(
    () => surfaced,
    (request) => {
        if (request !== undefined) {
            void tabs.surface();
        }
    },
);

const resizing = ref(false);
// The panel's bottom viewport offset, captured at drag start — its height is the pointer's distance above it.
let panelBottom = 0;

const startResize = (event: PointerEvent): void => {
    event.preventDefault();
    panelBottom = root.value?.getBoundingClientRect().bottom ?? 0;
    resizing.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};

const onResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    setHeight(panelBottom - event.clientY);
};

const endResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    resizing.value = false;
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
};
</script>

<template>
    <div
        ref="root"
        class="term relative flex min-h-0 shrink-0 border-t border-line"
        :class="[vertical ? 'flex-row' : 'flex-col', { 'is-resizing': resizing, 'h-full': !resizable }]"
        :style="resizable ? { height: `${height}px` } : undefined"
    >
        <div
            v-if="resizable"
            class="term-resize"
            @pointerdown="startResize"
            @pointermove="onResize"
            @pointerup="endResize"
            @dblclick="setHeight(DEFAULT_HEIGHT)"
            title="Drag to resize · double-click to reset"
        ></div>
        <!-- The bar: across the top when docked, down the left edge in the pop-out window (`vertical`). Same
             pills, same toolbar, same right-click menu — only the axis differs. -->
        <div
            class="flex shrink-0 gap-1 border-line bg-card"
            :class="vertical ? 'w-40 flex-col items-stretch border-r px-1 py-1.5' : 'items-center border-b px-2 py-0.5'"
            @contextmenu="onBarContextMenu"
        >
            <!-- One pill per split GROUP, one segment per tmux session, styled like the editor's FileTabs: glyph
                 (kind icon or the user's override, tinted by their color), label (or index), and — when the
                 source manages sessions — a small × that appears on hover. Click switches (and focuses the
                 clicked split); Shift/Ctrl+click multi-selects pills for the right-click mass actions; × kills
                 that session; + opens a new one. A dimmed segment is an untracked session (a finished one-shot
                 job's lingering shell, output in scrollback).

                 Pills fill one row, then wrap to a second (the chat strip's rule): a sandbox with a dozen
                 sessions used to push half of them off the right edge, where a tab you can't see is a tab you
                 forget is running. Only past two rows (max-h-13, the cap) does the strip scroll — vertically,
                 never sideways. One row leaves the bar at exactly its old height, so the terminal only gives up
                 rows once there are genuinely more tabs than fit. Rows sit a touch further apart than pills in a
                 row (gap-y-1 vs gap-x-0.5): stacked pill backgrounds need the separation to read as two rows. -->
            <div
                class="scrollbar-thin flex min-w-0 flex-1 gap-x-0.5 gap-y-1 overflow-x-hidden overflow-y-auto"
                :class="vertical ? 'min-h-0 flex-col items-stretch' : 'max-h-13 flex-wrap items-center'"
            >
                <div
                    v-for="(group, gi) in groups"
                    :key="groupKey(group)"
                    class="tterm group flex h-6 shrink-0 cursor-pointer select-none items-center rounded-md"
                    :class="[vertical ? 'w-full min-w-0' : '', { 'tterm-on': gi === activeGroupIndex, 'tterm-selected': isSelected(group) }]"
                >
                    <template v-for="(name, si) in group" :key="name">
                        <span v-if="si > 0" class="h-3.5 w-px shrink-0 bg-line"></span>
                        <div
                            class="flex h-full items-center gap-1.5 pl-2 pr-1.5 text-2xs"
                            :class="[vertical ? 'min-w-0 flex-1' : '', { 'opacity-60': tabByName.get(name)?.running === false }]"
                            v-tooltip.top="renamingName === name ? undefined : segmentTooltip(name)"
                            @click="onSegmentClick($event, gi, name)"
                            @dblclick.prevent.stop="beginRename(name)"
                            @contextmenu.prevent.stop="openTabMenu($event, gi, name)"
                        >
                            <Icon
                                :name="segmentIcon(name)"
                                class="text-2xs"
                                :class="
                                    segmentColor(name) === undefined
                                        ? tabByName.get(name)?.kind === 'agent'
                                            ? 'text-link'
                                            : 'text-muted'
                                        : undefined
                                "
                                :style="segmentColor(name) === undefined ? undefined : { color: segmentColor(name) }"
                            />
                            <!-- The label edits in place. The field sizes itself to the pill (a fixed w-24 —
                                 the strip must not jump as you type) and swallows the clicks it sits on, so a
                                 caret drag isn't also a tab switch. -->
                            <input
                                v-if="renamingName === name"
                                v-model="renameDraft"
                                type="text"
                                maxlength="40"
                                aria-label="Terminal name"
                                :placeholder="defaultLabel(name)"
                                class="w-24 min-w-0 select-text rounded bg-canvas px-1 text-2xs text-content outline-none ring-1 ring-line-strong placeholder:text-subtle"
                                @click.stop
                                @dblclick.stop
                                @keydown.enter.stop.prevent="commitRename"
                                @keydown.esc.stop.prevent="cancelRename"
                                @blur="commitRename"
                                @vue:mounted="focusRename"
                            />
                            <span v-else :class="vertical ? 'min-w-0 flex-1 truncate text-left' : undefined">{{ segmentLabel(name) }}</span>
                            <span
                                v-if="closeTab !== undefined && renamingName !== name"
                                class="relative flex h-3 w-3 shrink-0 items-center justify-center"
                                @click.stop="closeTab(name)"
                                aria-label="Kill terminal"
                            >
                                <Icon
                                    name="times"
                                    class="absolute rounded text-[0.6rem] opacity-0 transition-opacity hover:text-content group-hover:opacity-60"
                                />
                            </span>
                        </div>
                    </template>
                </div>
                <!-- The strip this sandbox was left with, while its sessions are still on their way: one shape
                     per remembered pill, as wide as that pill's splits made it. Inert and hidden from screen
                     readers — it is a place being held, not a tab (see `placeholders`). -->
                <div
                    v-for="(group, gi) in placeholders"
                    :key="`held-${gi}`"
                    class="flex h-6 shrink-0 animate-pulse items-center rounded-md bg-overlay/50 opacity-40"
                    :class="vertical ? 'w-full min-w-0' : ''"
                    aria-hidden="true"
                >
                    <template v-for="(name, si) in group" :key="name">
                        <span v-if="si > 0" class="h-3.5 w-px shrink-0 bg-line"></span>
                        <div class="flex h-full items-center px-2" :class="vertical ? 'min-w-0 flex-1' : ''">
                            <span class="h-2 w-8 rounded-full bg-line"></span>
                        </div>
                    </template>
                </div>
                <button
                    v-if="newTab !== undefined"
                    type="button"
                    class="flex h-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                    :class="vertical ? 'w-full' : 'w-6'"
                    @click="newTab()"
                    v-tooltip.top="withShortcut('New terminal', 'terminal.new')"
                    aria-label="New terminal"
                >
                    <Icon name="plus" class="text-2xs" />
                </button>
            </div>
            <!-- The toolbar: trailing the pills across the top, wrapped under them in the rail. -->
            <div class="flex shrink-0 items-center gap-1" :class="vertical ? 'flex-wrap justify-center border-t border-line pt-1.5' : undefined">
                <WorkTerminals />
                <BackgroundProcesses />
                <button
                    v-if="restart !== undefined && activeShell"
                    type="button"
                    :class="ui.iconButton()"
                    @click="restart()"
                    v-tooltip.top="'Restart shell'"
                    aria-label="Restart shell"
                >
                    <Icon name="refresh" class="text-xs" />
                </button>
                <button
                    v-else
                    type="button"
                    :class="ui.iconButton()"
                    @click="void tabs.refresh().catch(() => undefined)"
                    v-tooltip.top="'Refresh sessions'"
                    aria-label="Refresh sessions"
                >
                    <Icon name="refresh" class="text-xs" />
                </button>
                <!-- Into its own window, and back. It was a right-click-the-strip menu row only — the same
                     burial the chat's pop-out had, on a toolbar that has room to say it out loud. Beside the
                     close × because both answer "where does this panel live", and it flips with the state so
                     the one control is the whole round trip. -->
                <button type="button" :class="ui.iconButton()" @click="popout.toggle()" v-tooltip.top="popoutHint" :aria-label="popoutHint">
                    <Icon :name="popout.poppedOut.value ? 'arrow-down-left' : 'external-link'" class="text-xs" />
                </button>
                <button type="button" :class="ui.iconButton()" @click="emit(`close`)" v-tooltip.top="closeHint" :aria-label="closeHint">
                    <Icon :name="popout.poppedOut.value ? 'times' : 'chevron-down'" class="text-xs" />
                </button>
            </div>
        </div>
        <!-- The panes and the touch keys under them: always a column, whichever side the bar is on. -->
        <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <!-- THE AGENT ASKED FOR HANDS. Between the strip and the pane — directly over the prompt the owner
                 has to answer — and its buttons settle the parked request; it comes down on the daemon's own
                 push, the same one that raised it. The mirror of the Browsers banner, deliberately. -->
            <div v-if="help" class="flex shrink-0 flex-col gap-2 border-b border-line bg-warning/10 px-3 py-2">
                <div class="flex items-start gap-2">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-sm text-warning" />
                    <div class="min-w-0 flex-1 text-xs text-content">
                        <span class="font-medium">The agent needs your help:</span>
                        {{ help.message }}
                        <span class="text-muted"> — type it below, then hand back.</span>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <input
                        v-model="helpNote"
                        type="text"
                        placeholder="Optional note back to the agent"
                        class="min-w-40 flex-1 rounded border border-line bg-card px-2 py-1 text-xs text-content placeholder:text-subtle"
                        @keydown.enter="resolveHelp(true)"
                    />
                    <button
                        type="button"
                        class="shrink-0 rounded bg-primary-600 px-2 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
                        @click="resolveHelp(true)"
                    >
                        Done — hand back
                    </button>
                    <button
                        type="button"
                        class="shrink-0 rounded border border-line px-2 py-1 text-xs text-muted transition-colors hover:text-content"
                        @click="resolveHelp(false)"
                    >
                        Can't help now
                    </button>
                </div>
            </div>
            <!-- xterm sizes to this container; the session's fit observer keeps each cell filling its share of
                 the pane (useTerminal's mount builds one .term-cell per split). The right-click is caught here
                 rather than per cell because the cells are built imperatively — the handler reads which session
                 it landed in off the cell's own dataset. -->
            <div ref="container" class="term-body flex min-h-0 min-w-0 flex-1 bg-terminal p-2" @contextmenu="onGridContextMenu"></div>
            <!-- NOTHING TO SHOW, SAID OUT LOUD. The panel opened FOR a session suppresses the empty-panel shell
                 (see attach) because that session is normally seconds away — but a surface can ask for one that
                 will never arrive: a dev server someone started outside this sandbox has no terminal here, and
                 the button offering it left a black rectangle with no tabs, no message and no way to tell a slow
                 start from a session that never existed. An OVERLAY rather than a v-if on the container: the
                 container is the imperative mount target and must stay in the DOM at its real size. -->
            <div
                v-if="order.length === 0 && awaiting !== undefined && !waited"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
            >
                <Icon name="spinner" class="animate-spin text-lg text-subtle" />
                <p class="text-sm text-muted">
                    <template v-if="about?.title">{{ about.title }}…</template>
                    <template v-else
                        >Opening <span class="font-mono text-content">{{ named }}</span
                        >…</template
                    >
                </p>
                <!-- The command behind it. A check that opens a terminal by itself has to be able to say what
                     it is running, or the panel is back to offering a session name as the whole explanation. -->
                <p v-if="about?.detail" class="max-w-md truncate font-mono text-2xs text-subtle">{{ about.detail }}</p>
            </div>
            <!-- THE UNKNOWN MOMENT, WEARING ITS OWN SHAPE. Between opening this sandbox's panel and its daemon
                 saying what it runs there is nothing to show, and the state below — "No terminals open." — is an
                 answer. Stating it here meant retracting it a beat later, and on a daemon still waking it was
                 the only thing a returning user ever saw. -->
            <div
                v-else-if="order.length === 0 && answer === 'waiting'"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
            >
                <Icon name="spinner" class="animate-spin text-lg text-subtle" />
                <p class="text-sm text-muted">Looking for this sandbox's terminals…</p>
            </div>
            <div
                v-else-if="order.length === 0"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
            >
                <Icon :name="answer === 'refused' ? 'exclamation-triangle' : 'desktop'" class="text-2xl text-subtle" />
                <p v-if="about?.title" class="text-sm text-muted">{{ about.title }}</p>
                <p v-else-if="about" class="text-sm text-muted">
                    <span class="font-mono text-content">{{ named }}</span> {{ awaiting === undefined ? `isn't running.` : `` }}
                </p>
                <!-- "Nothing runs here" and "this sandbox never told us" are different sentences, and only one
                     of them is about the terminals. -->
                <p v-else class="text-sm text-muted">{{ answer === "refused" ? `Couldn't reach this sandbox.` : `No terminals open.` }}</p>
                <p class="max-w-md text-2xs text-subtle">{{ emptyHint }}</p>
                <Button
                    v-if="newTab !== undefined"
                    class="pointer-events-auto mt-1"
                    label="New terminal"
                    size="small"
                    severity="secondary"
                    @click="newTab()"
                >
                    <template #icon><Icon name="plus" class="text-2xs" /></template>
                </Button>
            </div>
            <!-- Touch extra-keys row (coarse pointers only). pointerdown.prevent keeps the terminal focused so
                 the soft keyboard stays up while the key is injected. -->
            <div v-if="coarse" class="scrollbar-thin flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-card px-1.5 py-1.5">
                <button type="button" class="termkey" :class="{ 'termkey-on': ctrlArmed }" @pointerdown.prevent="ctrlArmed = !ctrlArmed">Ctrl</button>
                <button v-for="key in EXTRA_KEYS" :key="key.label" type="button" class="termkey" @pointerdown.prevent="pressKey(key.data)">
                    {{ key.label }}
                </button>
            </div>
        </div>

        <!-- Right-click pill menu: split/join/unsplit/kill + the per-terminal cosmetic overrides. Rendered
             into the pop-out window while the panel floats there. -->
        <ContextMenu ref="menu" :model="menuItems" :append-to="popout.overlayTarget.value" :min-width="14" />

        <!-- Right-click INSIDE a terminal: the clipboard verbs and the scrollback, in the place tmux used to
             draw its own pane menu. -->
        <ContextMenu ref="gridMenu" :model="gridItems" :append-to="popout.overlayTarget.value" :min-width="12" />

        <!-- The pane's history as selectable text. The live grid can only ever offer the screenful in front of
             you — a tmux client runs on the alternate screen, so its scrollback never reaches the browser — and
             this is where "scroll back and copy that" is answered: real text, native selection, Ctrl+F. -->
        <Modal
            :open="scrollbackName !== undefined"
            size="xl"
            :scroll="false"
            :append-to="popout.overlayTarget.value"
            :header="scrollbackName === undefined ? '' : `Scrollback — ${segmentLabel(scrollbackName)}`"
            @update:open="closeScrollback"
        >
            <!-- Lays out its own height (hence <Modal :scroll="false">): the <pre> below is the scroller, and a
                 second one wrapped around it would put the "Copy all" row out of reach on a long scrollback. -->
            <div class="flex h-panel-lg min-h-0 flex-col gap-2">
                <div class="flex shrink-0 items-center gap-2 text-xs text-muted">
                    <template v-if="scrollback">
                        <span>{{ scrollback.lines.toLocaleString() }} lines</span>
                        <span v-if="scrollback.truncated">· older lines beyond this are still in tmux</span>
                        <Button class="ml-auto" size="small" severity="secondary" label="Copy all" @click="copyScrollback" />
                    </template>
                    <span v-else-if="scrollbackFailed">Couldn't read this terminal's scrollback — the session may have ended.</span>
                    <span v-else-if="scrollbackPending">Reading…</span>
                </div>
                <pre
                    v-if="scrollback"
                    ref="scrollbackText"
                    class="scrollbar-thin min-h-0 flex-1 overflow-auto rounded-md bg-terminal p-3 font-mono text-xs whitespace-pre text-content select-text"
                    >{{ scrollback.text }}</pre>
            </div>
        </Modal>

        <!-- The confirm a bulk kill gets when it would end sessions that are still running — this panel's
             counterpart of the chat's "stop N running agents?" and the workspace's unsaved-edits dialog. -->
        <ConfirmDialog
            :open="pendingKill !== undefined"
            :header="pendingKillRunning.length === 1 ? 'Kill the running terminal?' : `Kill ${pendingKillRunning.length} running terminals?`"
            confirm-label="Kill anyway"
            confirm-icon="trash"
            :items="pendingKillRunning"
            :append-to="popout.overlayTarget.value"
            @cancel="pendingKill = undefined"
            @confirm="confirmKill"
        >
            <template #item="{ item }">
                <Icon :name="segmentIcon(item.name)" class="shrink-0 text-2xs text-muted" />
                <span class="truncate text-content">{{ segmentLabel(item.name) }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">Killing these ends whatever they are running. Scrollback goes with them.</p>
        </ConfirmDialog>

        <!-- One dialog for the two pickers, color and icon: both apply on click, with a leading "default"
             swatch that clears the override. (Rename is inline in the strip, not here.) -->
        <Modal
            :open="customize !== undefined"
            size="sm"
            :append-to="popout.overlayTarget.value"
            :header="customizeHeader"
            @update:open="customize = undefined"
        >
            <template v-if="customize">
                <div v-if="customize.mode === 'color'" class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        :class="ui.addTile(`h-7 w-7 rounded-full text-subtle`)"
                        v-tooltip.top="'Default'"
                        aria-label="Default color"
                        @click="applyColor(undefined)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                    <button
                        v-for="[key, hex] in colorOptions"
                        :key="key"
                        type="button"
                        class="h-7 w-7 rounded-full transition-transform hover:scale-110"
                        :class="{ 'ring-2 ring-line-strong ring-offset-2 ring-offset-card': terminalMeta(customize.name).color === key }"
                        :style="{ background: hex }"
                        v-tooltip.top="key"
                        :aria-label="key"
                        @click="applyColor(key)"
                    ></button>
                </div>
                <div v-else class="grid grid-cols-8 gap-1.5">
                    <button
                        type="button"
                        :class="ui.addTile(`h-8 w-8 text-subtle`)"
                        v-tooltip.top="'Default'"
                        aria-label="Default icon"
                        @click="applyIcon(undefined)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                    <button
                        v-for="icon in TERMINAL_ICONS"
                        :key="icon"
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                        :class="{ 'bg-overlay text-content': terminalMeta(customize.name).icon === icon }"
                        :aria-label="icon"
                        @click="applyIcon(icon)"
                    >
                        <Icon :name="icon" class="text-sm" />
                    </button>
                </div>
            </template>
        </Modal>
    </div>
</template>

<style scoped>
/* Drag-to-resize handle on the panel's top edge (pointer-capture, mirrors Workspace's .ws-resize). */
.term-resize {
    position: absolute;
    inset: -3px 0 auto 0;
    height: 6px;
    cursor: row-resize;
    z-index: 20;
    touch-action: none;
    transition: background-color 0.15s;
}
.term-resize:hover,
.term.is-resizing .term-resize {
    background: color-mix(in srgb, var(--color-primary-500) 35%, transparent);
}
.term.is-resizing {
    user-select: none;
}

/* Terminal tab pill — mirrors FileTabs' .ftab muted→hover→active progression, kept rounded to sit among the
   toolbar's other rounded-md buttons. Selected (Shift/Ctrl+click) tints toward primary so a multi-selection
   reads at a glance without fighting the active pill's overlay. */
.tterm {
    color: var(--color-muted);
    transition:
        background-color 0.15s,
        color 0.15s;
}
.tterm:hover {
    background: color-mix(in srgb, var(--color-content) 6%, transparent);
    color: var(--color-content);
}
.tterm-on {
    background: var(--color-overlay);
    color: var(--color-content);
}
.tterm-selected {
    background: color-mix(in srgb, var(--color-primary-500) 14%, transparent);
    color: var(--color-content);
}
/* Split cells (built by useTerminal's mount — plain elements, hence :deep): equal flex columns with a hairline
   between, and a top accent on the focused pane so keystroke routing is visible in a split. */
.term-body :deep(.term-cell) {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
}
.term-body :deep(.term-cell + .term-cell) {
    border-left: 1px solid var(--color-line);
    margin-left: 0.5rem;
    padding-left: 0.5rem;
}
.term-body.term-split :deep(.term-cell:focus-within) {
    box-shadow: inset 0 2px 0 0 color-mix(in srgb, var(--color-primary-500) 55%, transparent);
}

/* Touch extra-keys: 40px min targets, monospace glyphs, armed-Ctrl tint. */
.termkey {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.5rem;
    height: 2.25rem;
    padding: 0 0.6rem;
    flex-shrink: 0;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-line);
    background: var(--color-canvas);
    color: var(--color-content);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.8125rem;
}
.termkey:active {
    background: var(--color-overlay);
}
.termkey-on {
    border-color: color-mix(in srgb, var(--color-primary-500) 60%, transparent);
    background: color-mix(in srgb, var(--color-primary-500) 16%, transparent);
    color: var(--color-primary-500);
}
</style>
