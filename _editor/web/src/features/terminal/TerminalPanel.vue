<script setup lang="ts">
import { Button, clipboardOf, ui, ConfirmDialog, ContextMenu, Icon, type IconName, Modal, ResizeSeam, useDevice, vAction } from "@intentic/ui";
import type { Disposable } from "@intentic/extension-api";
import type { TerminalScrollback } from "@intentic/sandbox-contract";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type VNode, watch } from "vue";
import BackgroundProcesses from "./BackgroundProcesses.vue";
import WorkTerminals from "./WorkTerminals.vue";
import { commandShortcut, type CommandRegistration, registerCommand, withShortcut } from "../../shell/commands/useCommands";
import { useSandbox } from "../sandbox/client/useSandbox";
import { showWorkTerminals } from "./useWorkTerminals";
import { KIND_ICONS, setTerminalMeta, TERMINAL_COLORS, TERMINAL_ICONS, type TerminalColor, terminalMeta } from "./terminalMeta";
import { useTerminalsQuery } from "./terminalsQuery";
import { inactiveTerminals } from "./terminalSweep";
import { fetchScrollback } from "./terminalScrollback";
import { copySelection, pasteIntoTerminal } from "./terminalSession";
import { createTerminalTabs, type TerminalTab, type TerminalTabsSource, terminalSessionOf } from "./useTerminal";
import { clearTerminalRequest, consumeSpawnRequest, registerTerminalSpawn, type TerminalRequest } from "./useTerminalPanel";
import { useTerminalFloating } from "./terminalFloating";
import { postTurnControl } from "../chat/run/turnStream";

// Terminal panel, mounted once below every view: each tab is a tmux session in the shared cache, so scrollback survives
// unmount, navigation, and reload. Tabs arrange into split groups (VSCode-style); Shift/Ctrl+click multi-selects pills,
// right-click opens split/join/kill and rename/color/icon. Poppable into its own window, bar moving to the left edge.

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
    // Session to relist as a tab without focusing it (the agent's live terminal); distinct from `initial`.
    surfaced?: { readonly name: string };
    resizable?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const tabs = createTerminalTabs(source, storageKey, () => emit(`close`));
const { order, groups, answer, activeName, switchTab, joinTabs, unsplit, newTab, splitTab, killTabs, restart } = tabs;

// Skeleton of the strip's last-known shape while its list is in flight: unlabeled and inert, since which terminals
// return is the daemon's to say. Capped so a heavily-split sandbox doesn't spend rows on decoration.
const PLACEHOLDER_LIMIT = 6;
const placeholders = computed(() =>
    answer.value === `waiting` && groups.value.length === 0 ? tabs.remembered.value.slice(0, PLACEHOLDER_LIMIT) : [],
);
// Whether Restart applies: a fresh shell replaces a killed one; meaningless for a dev-server tab.
const activeShell = computed(() => order.value.find((tab) => tab.name === activeName.value)?.kind === `shell`);
const floating = useTerminalFloating();
// Bar becomes a left rail while the panel has its own floating window.
const vertical = computed(() => floating.here.value);

// Sessions can finish with no client action; watching the shared list catches what imperative relists miss.
const listed = useTerminalsQuery();
watch(
    () => listed.sessions.value.map((session) => `${session.name}:${session.running}`).join(`\n`),
    // Absorbed: a dropped refresh is the strip's own to retry, and nothing here awaits this.
    () => void tabs.refresh().catch(() => undefined),
);

// Reachability regaining catches an outage longer than the refused-list retries cover, since an unreachable daemon
// reports no session changes at all.
watch(useSandbox().reachable, (isReachable) => {
    if (isReachable) {
        void tabs.refresh().catch(() => undefined);
    }
});

// Terminal-handover ask: whichever tab is active shows the ask meant for that session, since the pane needing an answer
// is the one right below it; a non-active ask still reaches the owner via chat and notification.
const help = computed(() => listed.sessions.value.find((session) => session.name === activeName.value)?.help);
const helpNote = ref(``);
watch(activeName, () => (helpNote.value = ``));
const resolveHelp = async (helped: boolean): Promise<void> => {
    const open = help.value;
    if (open === undefined) {
        return;
    }
    const note = helpNote.value.trim();
    // `undefined`: replies go to this sandbox's own daemon, which is the one that raised the ask.
    await postTurnControl(undefined, `/agent/reply`, { kind: `terminal_help`, requestId: open.requestId, helped, ...(note === `` ? {} : { note }) });
    helpNote.value = ``;
};

// Tab strip: segments, numbering, cosmetics.
const tabByName = computed(() => new Map(order.value.map((tab) => [tab.name, tab])));
// Unlabeled shells show their 1-based position in the strip's reading order across groups.
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
// Pop-out button's label and tooltip, matching the strip menu and palette row wording.
const floatHint = computed(() => withShortcut(floating.floats.value ? `Dock panel back` : `Move panel into new window`, `terminal.toggleFloating`));
// Dismissal, not a kill: sessions outlive every view; docked it hides the panel, floating it closes the window.
const closeHint = computed(() =>
    withShortcut(
        floating.here.value ? `Close the window, the terminals keep running` : `Hide the panel, the terminals keep running`,
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
    if (tab.kind === `process`) {
        return `Background process: read-only logs`;
    }
    // What's running leads, since on a crowded strip the command is the only thing naming the terminal to close.
    const doing = tab.command === undefined ? undefined : `Running ${tab.command}`;
    if (tab.kind === `agent`) {
        return doing ?? (tab.running === false ? `AI terminal, finished` : `AI terminal`);
    }
    if (tab.kind === `job`) {
        return doing ?? `Job terminal`;
    }
    return doing ?? (tab.running === false ? `finished` : undefined);
};

// Multi-selection (VSCode-style): Shift extends, Ctrl toggles, click activates; selection is per-group, keyed by its
// first session, feeding only the context menu's mass actions.
const selectedKeys = ref<string[]>([]);
const anchor = ref<number | undefined>(undefined);
const groupKey = (group: string[]): string => group[0] ?? ``;
const isSelected = (group: string[]): boolean => selectedKeys.value.includes(groupKey(group));
const selectedGroups = computed(() => groups.value.filter((group) => isSelected(group)));
// Flattened in strip order, so a joined pane reads left-to-right as the strip did.
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

// Killing.
// Every kill confirms when there's something to lose: a busy session, or two-or-more live ones at once.
const killable = computed(() => order.value.filter((tab) => tab.kind !== `process`).map((tab) => tab.name));
// Sweep's clock, stamped when a menu opens or a sweep fires, not ticked, so the count and the kill agree without a
// per-second re-render.
const sweepNow = ref(Date.now());
const inactive = computed(() => inactiveTerminals(order.value, { now: sweepNow.value, focused: activeName.value }));
const sweepInactive = (): void => {
    if (killTabs === undefined) {
        return;
    }
    sweepNow.value = Date.now();
    const names = inactive.value.map((tab) => tab.name);
    if (names.length === 0) {
        return;
    }
    killTabs(names);
    selectedKeys.value = [];
};
// What a dialog stands over: a busy session, or a bulk kill the gesture never named.
const pendingKill = ref<string[]>();
const runningIn = (names: string[]): TerminalTab[] => order.value.filter((tab) => names.includes(tab.name) && tab.running);
// Tabs with work in them; a process's × closes a view, not a session, so it never asks this question.
const busyIn = (names: string[]): TerminalTab[] =>
    order.value.filter((tab) => names.includes(tab.name) && tab.kind !== `process` && tab.command !== undefined);
const isBusy = (name: string): boolean => {
    const tab = tabByName.value.get(name);
    return tab !== undefined && tab.kind !== `process` && tab.command !== undefined;
};
// What the dialog lists: busy sessions if that's why it opened, else the live ones a kill ends; never both.
const pendingKillBusy = computed(() => (pendingKill.value === undefined ? [] : busyIn(pendingKill.value)));
const pendingKillItems = computed(() => {
    const names = pendingKill.value;
    if (names === undefined) {
        return [];
    }
    const busy = pendingKillBusy.value;
    return busy.length > 0 ? busy : runningIn(names);
});
const killHeader = computed(() => {
    const busy = pendingKillBusy.value;
    if (busy.length === 1) {
        // The command IS the question; truncated since a session can be running something with a long name.
        return `Kill the terminal running ${(busy[0]?.command ?? ``).slice(0, 24)}?`;
    }
    if (busy.length > 1) {
        return `Kill ${busy.length} busy terminals?`;
    }
    const count = pendingKillItems.value.length;
    return count === 1 ? `Kill the running terminal?` : `Kill ${count} running terminals?`;
});
const killBody = computed(() =>
    pendingKillBusy.value.length > 0
        ? `This stops what ${pendingKillBusy.value.length === 1 ? `it is` : `they are`} doing. Scrollback goes with it, and there is no undo.`
        : `Killing these ends whatever they are running. Scrollback goes with them.`,
);
const requestKill = (names: string[]): void => {
    if (killTabs === undefined || names.length === 0) {
        return;
    }
    // Nothing running and nothing bulk: the click is the whole decision.
    if (busyIn(names).length === 0 && (names.length === 1 || runningIn(names).length === 0)) {
        killTabs(names);
        selectedKeys.value = [];
        return;
    }
    pendingKill.value = names;
};
const confirmKill = (): void => {
    const names = pendingKill.value;
    if (names !== undefined) {
        killTabs?.(names);
        selectedKeys.value = [];
    }
    pendingKill.value = undefined;
};

// Pill label edits in place, like a chat tab or workspace file: Enter commits, Esc cancels, blur commits, and an empty
// name resets to the default.
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
        return; // Enter already committed this; the unmount blur must not commit again.
    }
    const trimmed = renameDraft.value.trim();
    setTerminalMeta(name, { label: trimmed === `` ? undefined : trimmed });
};
const cancelRename = (): void => {
    renamingName.value = undefined;
};
// Focuses and selects the field the moment it mounts (the @vue:mounted trick).
const focusRename = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
};
// Fallback label a cleared name resets to; shown as the input's placeholder so 'empty resets' is visible.
const defaultLabel = (name: string): string => tabByName.value.get(name)?.label ?? `Terminal ${stripIndex.value.get(name) ?? ``}`;

// Color/icon overrides live in a dialog: a swatch grid is a picker, not a text field, with nowhere to sit in a pill.
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

// Context menu (right-click a pill).
const menu = ref<{ show: (event: Event) => void } | undefined>();
const menuTarget = ref<{ groupIndex: number; name: string } | undefined>(undefined);
const openTabMenu = (event: MouseEvent, groupIndex: number, name: string): void => {
    // Sweep's clock, read the moment its row is about to be drawn.
    sweepNow.value = Date.now();
    const group = groups.value[groupIndex] ?? [];
    // Right-click outside the current selection retargets it (VSCode's list behavior).
    if (!isSelected(group)) {
        selectedKeys.value = [groupKey(group)];
        anchor.value = groupIndex;
    }
    menuTarget.value = { groupIndex, name };
    menu.value?.show(event);
};

// Rows naming no particular pill: strip-wide kills, the sweep, and pop-out; also the whole menu a right-click on empty
// bar space opens. Each row is absent when it would be a no-op.
const stripItems = computed<MenuItem[]>(() => {
    const items: MenuItem[] = [];
    // Above kill-all as the narrower option; absent when there's nothing for it to find.
    if (killTabs !== undefined && inactive.value.length > 0) {
        items.push({
            label: `Kill ${inactive.value.length} inactive ${inactive.value.length === 1 ? `terminal` : `terminals`}`,
            shortcut: commandShortcut(`terminal.killInactive`),
            command: sweepInactive,
        });
    }
    if (killTabs !== undefined && killable.value.length > 0) {
        items.push({ label: `Kill all terminals`, shortcut: commandShortcut(`terminal.killAll`), command: () => requestKill(killable.value) });
    }
    items.push(
        ...(items.length > 0 ? [{ separator: true }] : []),
        // The one checked row here: whether work terminals tab at all, same preference as the popover and Settings.
        {
            label: `Show work terminals`,
            checked: showWorkTerminals.value,
            shortcut: commandShortcut(`terminal.toggleWorkTerminals`),
            command: () => (showWorkTerminals.value = !showWorkTerminals.value),
        },
        {
            label: floating.floats.value ? `Dock panel back` : `Move panel into new window`,
            shortcut: commandShortcut(`terminal.toggleFloating`),
            command: floating.toggle,
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
    // Multi-selection gets mass actions, a single pill gets per-terminal ones, each showing its shortcut.
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
    if (killTabs !== undefined) {
        items.push(
            { separator: true },
            {
                label: tabByName.value.get(name)?.kind === `process` ? `Close log view` : `Kill terminal`,
                shortcut: commandShortcut(`terminal.kill`),
                // Routed through requestKill like any kill; a menu row knows no more about a busy session than the ×.
                command: () => requestKill([name]),
            },
        );
    }
    return [...items, ...stripItems.value];
});

// Pane's history as selectable plain text. `pending` is its own state, not a spinner over stale text, since showing the
// previous terminal's scrollback while the next loads would be the worst lie here.
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
        // Superseded while in flight: the dialog closed, or another terminal was asked for.
        if (scrollbackName.value === name) {
            scrollback.value = captured;
        }
    } catch {
        // Session ended between the click and the read, or the daemon went away; say so rather than spin forever.
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

// Through the dialog's own element, so a floating panel writes from the window the user is actually in.
const copyScrollback = async (): Promise<void> => {
    const text = scrollback.value?.text;
    if (text !== undefined) {
        await clipboardOf(scrollbackText.value).writeText(text);
    }
};

// Grid right-click: clipboard verbs plus scrollback beyond what attach replayed; tmux never sees it, since the client
// is control-mode. Targets the session under the pointer, not the focused one.
const gridMenu = ref<{ show: (event: Event) => void } | undefined>();
const gridTarget = ref<string | undefined>(undefined);
// Sampled at open, not read live: `disabled` renders once, and xterm clears selection losing focus.
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
    // Copy/Paste carry no shortcut hint, since Ctrl+Shift+C/V are the browser's own and plain Ctrl+V already pastes.
    // Both hand focus back to the terminal so the next keystroke doesn't land nowhere.
    const items: MenuItem[] = [
        {
            label: `Copy`,
            disabled: !gridHasSelection.value,
            command: () => {
                copySelection(session);
                session.term.focus();
            },
        },
        { label: `Paste`, command: () => pasteIntoTerminal(session) },
        { separator: true },
        { label: `Full scrollback…`, command: () => void openScrollback(name) },
    ];
    if (splitTab !== undefined) {
        items.push({ separator: true }, { label: `Split terminal`, shortcut: commandShortcut(`terminal.split`), command: () => splitTab(name) });
    }
    return items;
});

// Ctrl+F over the active session's whole buffer, like a local terminal: matches paint in place and on the scrollbar,
// Enter walks them. Decorations clear when the bar closes or the tab changes.
const finding = ref(false);
const findQuery = ref(``);
const findInput = ref<HTMLInputElement>();
// Addon's own match count, -1 past its 1000-match ceiling; undefined until a query has run.
const findResults = ref<{ index: number; count: number } | undefined>(undefined);
// Session whose decorations are up and events bound, so switching tabs clears one before painting the next.
let findBound: { search: { clearDecorations: () => void }; results: { dispose: () => void } } | undefined;

// Yellow, the palette's 'look here' color; the active match saturates so it stands out among the rest.
const FIND_DECORATIONS = {
    matchBackground: `#facc1540`,
    matchBorder: `#facc1580`,
    matchOverviewRuler: `#facc15`,
    activeMatchBackground: `#facc15a0`,
    activeMatchBorder: `#facc15`,
    activeMatchColorOverviewRuler: `#fde047`,
};

const activeSession = () => (activeName.value === undefined ? undefined : terminalSessionOf(activeName.value));

const unbindFind = (): void => {
    findBound?.results.dispose();
    findBound?.search.clearDecorations();
    findBound = undefined;
    findResults.value = undefined;
};

const bindFind = (): void => {
    unbindFind();
    const session = activeSession();
    if (session === undefined) {
        return;
    }
    findBound = {
        search: session.search,
        results: session.search.onDidChangeResults(({ resultIndex, resultCount }) => {
            findResults.value = { index: resultIndex, count: resultCount };
        }),
    };
};

const runFind = (incremental: boolean): void => {
    const session = activeSession();
    if (session === undefined) {
        return;
    }
    if (findBound?.search !== session.search) {
        bindFind();
    }
    if (findQuery.value === ``) {
        session.search.clearDecorations();
        findResults.value = undefined;
        return;
    }
    session.search.findNext(findQuery.value, { incremental, decorations: FIND_DECORATIONS });
};
const findNext = (): void => runFind(false);
const findPrevious = (): void => {
    const session = activeSession();
    if (session !== undefined && findQuery.value !== ``) {
        session.search.findPrevious(findQuery.value, { decorations: FIND_DECORATIONS });
    }
};

const openFind = (): void => {
    if (activeName.value === undefined) {
        return;
    }
    finding.value = true;
    void nextTick(() => {
        findInput.value?.focus();
        findInput.value?.select();
    });
    if (findQuery.value !== ``) {
        runFind(true);
    }
};

// Esc, or the ×: hands the keyboard back to the terminal and clears the highlights.
const closeFind = (): void => {
    finding.value = false;
    unbindFind();
    activeSession()?.term.focus();
};

const findLabel = computed((): string => {
    const results = findResults.value;
    if (results === undefined) {
        return ``;
    }
    if (results.count === 0) {
        return `No results`;
    }
    return `${String(results.index + 1)} of ${results.count < 0 ? `many` : String(results.count)}`;
});

// A find follows the active tab: highlights leave the one that lost focus, rerunning on the one that gained it.
watch(activeName, () => {
    if (finding.value) {
        runFind(true);
    }
});
onBeforeUnmount(unbindFind);

// Height persists per surface, clamped between a floor and ~80% of viewport. No collapsed state: the toolbar's ×
// already unmounts without killing sessions.
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

const height = ref(readHeight());
const setHeight = (px: number): void => {
    height.value = clampHeight(px);
    write(HEIGHT_KEY, String(height.value));
};

// Alt+PageDown/Up walk every session in reading order, splits included, wrapping at the ends.
const cycleTab = (delta: number): void => {
    const names = groups.value.flat();
    if (names.length < 2) {
        return;
    }
    // oxlint-disable-next-line unicorn/prefer-array-index-of -- activeName.value is `string | undefined`, which indexOf will not accept.
    const index = names.findIndex((name) => name === activeName.value);
    const next = names[(index + delta + names.length) % names.length];
    if (next !== undefined) {
        switchTab(next);
    }
};

// Every strip action is a registered command, live only while this panel is mounted. Tab-family chords match the
// workspace/chat strips, gated on this panel's focus; the panel's own verbs keep private, ungated chords. Defaults are
// Ctrl+Shift+<key>, dodging bare Ctrl (the shell's) and Ctrl+Alt (AltGr); everything is rebindable per surface.
let commandDisposables: readonly Disposable[] = [];
const registerPanelCommands = (): void => {
    const entries: Omit<CommandRegistration, `owner`>[] = [
        {
            command: `terminal.rename`,
            title: `Rename Terminal`,
            icon: `pencil`,
            // F2, gated to a keystroke from inside this panel; outside it the chord stays free for other surfaces.
            keybinding: `F2`,
            when: `tabSurface == 'terminal'`,
            handler: (): void => {
                if (renamingName.value !== undefined) {
                    return; // already editing (F2 lands in the field); restarting would wipe the draft
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
            // Unbound by default, like the cosmetic pickers: already has two clickable homes.
            command: `terminal.toggleWorkTerminals`,
            title: `Toggle Work Terminals in Panel`,
            icon: `sparkles`,
            handler: (): void => {
                showWorkTerminals.value = !showWorkTerminals.value;
            },
        },
        {
            command: `terminal.find`,
            title: `Find in Terminal`,
            icon: `search`,
            // Cmd+F on Mac, Ctrl+F elsewhere, gated to this panel so the page find keeps the chord elsewhere.
            keybinding: `Mod+F`,
            when: `tabSurface == 'terminal'`,
            handler: openFind,
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
    if (killTabs !== undefined) {
        entries.push({
            command: `terminal.kill`,
            title: `Kill Terminal`,
            icon: `trash`,
            keybinding: `Ctrl+Shift+X`,
            when: `tabSurface == 'terminal'`,
            handler: (): void => {
                // Selection first, else the focused session; the chord has the least aim of the three kill gestures.
                if (selectedNames.value.length > 0) {
                    requestKill(selectedNames.value);
                    return;
                }
                if (activeName.value !== undefined) {
                    requestKill([activeName.value]);
                }
            },
        });
        entries.push({
            command: `terminal.killAll`,
            title: `Kill All Terminals`,
            icon: `trash`,
            keybinding: `Ctrl+Shift+Backspace`,
            when: `tabSurface == 'terminal'`,
            handler: () => requestKill(killable.value),
        });
        entries.push({
            command: `terminal.killInactive`,
            title: `Kill Inactive Terminals`,
            icon: `trash`,
            // Unbound: tidying is occasional, and a chord for it would sit one slip from the one that kills your shell.
            handler: sweepInactive,
        });
    }
    commandDisposables = entries.map((entry) => registerCommand({ owner: `builtin`, ...entry }));
};

// Right-click on empty bar space (not a pill or button) opens the strip-wide menu: sweep, kill all, pop out.
const onBarContextMenu = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(`button, [data-term-tab]`) !== null) {
        return;
    }
    event.preventDefault();
    sweepNow.value = Date.now();
    menuTarget.value = undefined;
    menu.value?.show(event);
};

// Touch extra-keys row: a soft keyboard has no Esc/Tab/Ctrl/arrows, so a scrollable row injects them directly. Desktop
// never renders it.
const { coarse } = useDevice();

// Control code for a printable char (c to \x03, d to \x04, ...); non-letters pass through.
const controlCode = (ch: string): string => {
    const code = ch.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : ch;
};

// Ctrl arms, then the next printable keydown sends its control code, the only reliable way to reach Ctrl+C/D/Z with no
// physical modifier.
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

// One class string for both the Ctrl toggle and the keys below, matching the kit's own style (lib/ui.ts). 44px: these
// only exist on a coarse pointer, the most repeatedly pressed controls the app has on a phone, at the screen's bottom
// edge where thumb accuracy is worst.
const KEY_CLASS = `inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-line bg-canvas px-[0.6rem] font-mono text-[0.8125rem] text-content active:bg-overlay`;

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
// pointerdown, not click, with preventDefault: keeps the xterm textarea focused so the soft keyboard stays up.
const pressKey = (data: string): void => tabs.sendInput(data);

const container = ref<HTMLElement>();

// Spawn-hook disposer, registered before the relist awaits, so a rejected list can't break 'New Terminal'.
let disposeSpawn: (() => void) | undefined;
// Panel can be torn down and reopened by a v-if, so async code must check it's still live before acting.
let live = true;

// What the panel is waiting for and what it says about it: `tabs.pending` is the wait itself, held until the session
// lists; `waited` flips after a delay so the panel admits defeat instead of spinning forever.
const about = ref<TerminalRequest | undefined>(initial);
const awaiting = computed(() => tabs.pending.value);
// How long the panel holds itself empty for an on-the-way session: long enough for a slow start, short enough to not
// look stuck.
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

// What the panel calls itself while empty: a caller's own sentence, else the session name as its id.
const named = computed(() => awaiting.value ?? about.value?.name ?? ``);
const emptyHint = computed(() => {
    if (awaiting.value !== undefined) {
        // The wait still stands; it only stopped holding the panel empty, unlike a bare spinner with nothing behind it.
        return `It hasn't appeared yet: the sandbox is probably still starting it. This panel keeps looking and shows it the moment it's listed.`;
    }
    if (answer.value === `refused`) {
        // The one case where it's the asking that failed, not the sandbox that's empty.
        return `This sandbox didn't answer when asked what it was running. Anything already going is still going: try again from the refresh button.`;
    }
    return about.value === undefined
        ? `Open one to run something here.`
        : `Nothing in this sandbox runs under that name, it was started outside it, or it has already stopped.`;
});

// Takes the request and spends it: standing in module state lets it open a panel not yet mounted, but left standing it
// would replay on the next mount, hours later.
const openRequested = async (request: TerminalRequest): Promise<void> => {
    about.value = request;
    clearTerminalRequest();
    // A dropped list isn't a failed open: focus records the wait first, so the tab still arrives when listed.
    await tabs.focus(request.name).catch(() => undefined);
};

onMounted(async () => {
    registerPanelCommands();
    const pane = container.value;
    if (pane === undefined) {
        // Nothing to attach to: both requests are module state, spent here rather than handed to the next mount.
        consumeSpawnRequest();
        clearTerminalRequest();
        return;
    }
    // `initial` at mount means the panel opened FOR that session; attach skips the empty-panel shell for it.
    const attaching = tabs.attach(pane, initial?.name);
    if (newTab !== undefined) {
        disposeSpawn = registerTerminalSpawn(newTab);
    }
    const autoCreated = await attaching;
    // Spends the spawn request regardless of outcome, read before any skippable branch: a raced press opens into
    // whatever panel comes up next, and the auto-created empty-panel shell already IS that terminal.
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
// Parent-driven focus (a row's button while already open): a fresh object re-focuses even the same session.
watch(
    () => initial,
    (request) => {
        if (request !== undefined) {
            void openRequested(request);
        }
    },
);
// Parent-driven surface request (agent started Bash): relists without focusing; meaningless once closed.
watch(
    () => surfaced,
    (request) => {
        if (request !== undefined) {
            void tabs.surface();
        }
    },
);

// This height is the one dimension already in screen pixels (compared to innerHeight; the terminal paints from a
// number), so unlike other ResizeSeam callers there's no unit conversion here.
const seamHeight = computed<number>({
    get: () => height.value,
    set: setHeight,
});
// Read at render, not stored: the cap is a share of a viewport the reader can resize underneath it.
const maxHeight = computed(() => Math.round(window.innerHeight * 0.8));
</script>

<template>
    <div
        class="term relative flex min-h-0 shrink-0 border-t border-line"
        :class="[vertical ? 'flex-row' : 'flex-col', { 'h-full': !resizable }]"
        :style="resizable ? { height: `${height}px` } : undefined"
    >
        <!--
            Seam rides the panel's top edge in flow; its negative margin gives back the height it takes. `pane="after"` since the panel is below it,
            so dragging up grows it.
        -->
        <ResizeSeam
            v-if="resizable"
            v-model="seamHeight"
            axis="y"
            pane="after"
            :min="MIN_HEIGHT"
            :max="maxHeight"
            :reset="DEFAULT_HEIGHT"
            title="Drag to resize · double-click to reset"
        />
        <!-- Bar: across the top when docked, down the left edge floating (`vertical`); same pills, toolbar, and menu either way. -->
        <div
            class="flex shrink-0 gap-1 border-line bg-card"
            :class="vertical ? 'w-40 flex-col items-stretch border-r px-1 py-1.5' : 'items-center border-b px-2 py-0.5'"
            @contextmenu="onBarContextMenu"
        >
            <!--
                One pill per split group, one segment per session, styled like FileTabs: glyph, label, and a hover ×. Click switches,
                Shift/Ctrl+click multi-selects, × kills. Pills wrap after one row (never sideways) up to a two-row cap, so a tab stays visible
                without pushing others off-screen.
            -->
            <div
                class="scrollbar-thin flex min-w-0 flex-1 gap-x-0.5 gap-y-1 overflow-x-hidden overflow-y-auto"
                :class="vertical ? 'min-h-0 flex-col items-stretch' : 'max-h-13 flex-wrap items-center'"
            >
                <div
                    v-for="(group, gi) in groups"
                    :key="groupKey(group)"
                    data-term-tab
                    class="group flex h-6 shrink-0 cursor-pointer select-none items-center rounded-md transition-colors"
                    :class="[
                        vertical ? 'w-full min-w-0' : '',
                        isSelected(group)
                            ? 'bg-primary-500/14 text-content'
                            : gi === activeGroupIndex
                              ? 'bg-overlay text-content'
                              : 'text-muted hover:bg-content/6 hover:text-content',
                    ]"
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
                            <!--
                                Sizes to the pill (fixed width, so the strip doesn't jump while typing) and swallows its own clicks so a caret drag
                                isn't also a tab switch.
                            -->
                            <input
                                v-if="renamingName === name"
                                v-model="renameDraft"
                                type="text"
                                maxlength="40"
                                aria-label="Terminal name"
                                :placeholder="defaultLabel(name)"
                                class="ui-field-box ui-field-inline w-24 min-w-0 select-text px-1 text-2xs"
                                @click.stop
                                @dblclick.stop
                                @keydown.enter.stop.prevent="commitRename"
                                @keydown.esc.stop.prevent="cancelRename"
                                @blur="commitRename"
                                @vue:mounted="focusRename"
                            />
                            <span v-else :class="vertical ? 'min-w-0 flex-1 truncate text-left' : undefined">{{ segmentLabel(name) }}</span>
                            <!--
                                What it's running, live, on the pill: the reason a mis-close is rare, since look-alike pills otherwise give no way to
                                tell an idle shell from one mid-build. Dropped on a split segment (no room); the dot alone still says busy.
                            -->
                            <span
                                v-if="isBusy(name) && (vertical || group.length === 1)"
                                class="min-w-0 max-w-24 shrink truncate font-mono text-[0.6rem] text-muted"
                                >{{ tabByName.get(name)?.command }}</span
                            >
                            <span v-if="isBusy(name)" class="size-1.5 shrink-0 rounded-full bg-link" aria-hidden="true"></span>
                            <span
                                v-if="killTabs !== undefined && renamingName !== name"
                                class="relative flex h-3 w-3 shrink-0 items-center justify-center"
                                @click.stop="requestKill([name])"
                                :aria-label="isBusy(name) ? `Kill terminal, running ${tabByName.get(name)?.command}` : `Kill terminal`"
                            >
                                <Icon
                                    name="times"
                                    class="absolute rounded text-[0.6rem] opacity-0 transition-opacity hover:text-content group-hover:opacity-60"
                                />
                            </span>
                        </div>
                    </template>
                </div>
                <!--
                    Shape of the strip this sandbox was left with, before its sessions are known: one block per remembered pill, inert and hidden
                    from screen readers since it names nothing yet.
                -->
                <div
                    v-for="(group, gi) in placeholders"
                    :key="`held-${gi}`"
                    class="flex h-6 shrink-0 items-center rounded-md bg-overlay/50 opacity-40"
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
            <!-- Toolbar: trailing the pills across the top, wrapped under them in the rail. -->
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
                    @click="tabs.refresh().catch(() => undefined)"
                    v-tooltip.top="'Refresh sessions'"
                    aria-label="Refresh sessions"
                >
                    <Icon name="refresh" class="text-xs" />
                </button>
                <!--
                    Pop out into its own window, and back; was buried as a menu row only, now on the toolbar beside close since both answer 'where
                    does this panel live'.
                -->
                <button type="button" :class="ui.iconButton()" @click="floating.toggle()" v-tooltip.top="floatHint" :aria-label="floatHint">
                    <Icon :name="floating.floats.value ? 'arrow-down-left' : 'external-link'" class="text-xs" />
                </button>
                <button type="button" :class="ui.iconButton()" @click="emit(`close`)" v-tooltip.top="closeHint" :aria-label="closeHint">
                    <Icon :name="floating.here.value ? 'times' : 'chevron-down'" class="text-xs" />
                </button>
            </div>
        </div>
        <!-- Panes and the touch keys under them: always a column, whichever side the bar is on. -->
        <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <!--
                Agent asking for hands: sits between strip and pane, directly over the prompt it's about; its buttons settle the request, and it
                closes on the daemon's own push. Mirrors the Browsers banner.
            -->
            <div v-if="help" class="flex shrink-0 flex-col gap-2 border-b border-line bg-warning/10 px-3 py-2">
                <div class="flex items-start gap-2">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-sm text-warning" />
                    <div class="min-w-0 flex-1 text-xs text-content">
                        <span class="font-medium">The agent needs your help:</span>
                        {{ help.message }}
                        <span class="text-muted">: type it below, then hand back.</span>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <input
                        v-model="helpNote"
                        type="text"
                        placeholder="Optional note back to the agent"
                        class="ui-field-box ui-field-sm min-w-40 flex-1"
                        @keydown.enter="resolveHelp(true)"
                    />
                    <Button size="small" class="shrink-0" @click="() => resolveHelp(true)"> Done: hand back </Button>
                    <Button size="small" severity="secondary" class="shrink-0" @click="() => resolveHelp(false)"> Can't help now </Button>
                </div>
            </div>
            <!--
                xterm sizes to this container; each split's fit observer fills its own cell. Right-click is caught here, not per cell, and reads
                which session it landed in off the cell's dataset.
            -->
            <div ref="container" class="term-body flex min-h-0 min-w-0 flex-1 bg-terminal p-2" @contextmenu="onGridContextMenu"></div>
            <!--
                Find sits over the pane's top-right corner (VSCode's placement) so highlighted rows stay visible under it. Enter/Shift+Enter walk
                matches; Esc hands the keyboard back.
            -->
            <div
                v-if="finding"
                class="absolute top-1 right-4 z-10 flex items-center gap-1 rounded-md border border-line bg-card px-1.5 py-1 shadow-md"
                @keydown.esc.prevent="closeFind"
            >
                <Icon name="search" class="text-2xs text-muted" />
                <input
                    ref="findInput"
                    v-model="findQuery"
                    type="text"
                    placeholder="Find"
                    aria-label="Find in terminal"
                    class="ui-field-box ui-field-sm w-44"
                    @input="runFind(true)"
                    @keydown.enter.exact.prevent="findNext"
                    @keydown.shift.enter.prevent="findPrevious"
                />
                <span class="min-w-14 text-center font-mono text-2xs text-muted" aria-live="polite">{{ findLabel }}</span>
                <button
                    type="button"
                    :class="ui.iconButton()"
                    aria-label="Previous match"
                    v-tooltip.top="'Previous match (Shift+Enter)'"
                    @click="findPrevious"
                >
                    <Icon name="chevron-up" />
                </button>
                <button type="button" :class="ui.iconButton()" aria-label="Next match" v-tooltip.top="'Next match (Enter)'" @click="findNext">
                    <Icon name="chevron-down" />
                </button>
                <button type="button" :class="ui.iconButton()" aria-label="Close find" v-tooltip.top="'Close (Esc)'" @click="closeFind">
                    <Icon name="times" />
                </button>
            </div>
            <!--
                Nothing to show, said explicitly: a panel opened FOR a session normally has it seconds away, but the target can simply not exist. An
                overlay, not a v-if, since the container must stay mounted at its real size.
            -->
            <div
                v-if="order.length === 0 && awaiting !== undefined && !waited"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
            >
                <Icon name="spinner" spin class="text-lg text-subtle" />
                <p class="text-sm text-muted">
                    <template v-if="about?.title">{{ about.title }}…</template>
                    <template v-else
                        >Opening <span class="font-mono text-content">{{ named }}</span
                        >…</template
                    >
                </p>
                <!-- Command behind it, so a check that opened this terminal can say what it's running, not just its name. -->
                <p v-if="about?.detail" class="max-w-md truncate font-mono text-2xs text-subtle">{{ about.detail }}</p>
            </div>
            <!--
                Unknown moment gets its own shape: between opening the panel and the daemon saying what it runs, there's nothing to show yet, which
                is not the same claim as 'No terminals open.'
            -->
            <div
                v-else-if="order.length === 0 && answer === 'waiting'"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
            >
                <Icon name="spinner" spin class="text-lg text-subtle" />
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
                <!-- 'Nothing runs here' and 'this sandbox never answered' are different sentences; only one is about the terminals. -->
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
            <!-- Touch extra-keys row (coarse pointers only); pointerdown.prevent keeps the terminal focused so the soft keyboard stays up. -->
            <div v-if="coarse" class="scrollbar-thin flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-card px-1.5 py-1.5">
                <button
                    type="button"
                    :class="[KEY_CLASS, ctrlArmed ? 'border-primary-500/60 bg-primary-500/16 text-primary-500' : '']"
                    @pointerdown.prevent="ctrlArmed = !ctrlArmed"
                >
                    Ctrl
                </button>
                <button v-for="key in EXTRA_KEYS" :key="key.label" type="button" :class="KEY_CLASS" @pointerdown.prevent="pressKey(key.data)">
                    {{ key.label }}
                </button>
            </div>
        </div>

        <!-- Right-click pill menu: split/join/unsplit/kill plus per-terminal color/icon; rendered into the floating window while it floats. -->
        <ContextMenu ref="menu" :model="menuItems" :min-width="14" />

        <!-- Right-click inside a terminal: clipboard verbs and the deeper scrollback. -->
        <ContextMenu ref="gridMenu" :model="gridItems" :min-width="12" />

        <!--
            Pane's history as selectable text, beyond what the live grid holds: attach replays only the last few thousand lines into xterm, and tmux
            keeps far more.
        -->
        <Modal
            :open="scrollbackName !== undefined"
            size="xl"
            :scroll="false"
            :header="scrollbackName === undefined ? '' : `Scrollback, ${segmentLabel(scrollbackName)}`"
            @update:open="closeScrollback"
        >
            <!--
                Lays out its own height (`:scroll="false"`): the <pre> below is the scroller, so a second one around it wouldn't leave the Copy-all
                row reachable.
            -->
            <div class="flex h-panel-lg min-h-0 flex-col gap-2">
                <div class="flex shrink-0 items-center gap-2 text-xs text-muted">
                    <template v-if="scrollback">
                        <span>{{ scrollback.lines.toLocaleString() }} lines</span>
                        <span v-if="scrollback.truncated">· older lines beyond this are still in tmux</span>
                        <Button class="ml-auto" size="small" severity="secondary" label="Copy all" @click="copyScrollback" />
                    </template>
                    <span v-else-if="scrollbackFailed">Couldn't read this terminal's scrollback: the session may have ended.</span>
                    <span v-else-if="scrollbackPending">Reading…</span>
                </div>
                <pre
                    v-if="scrollback"
                    ref="scrollbackText"
                    class="scrollbar-thin min-h-0 flex-1 overflow-auto rounded-md bg-terminal p-3 font-mono text-xs whitespace-pre text-content select-text"
                    >{{ scrollback.text }}</pre>
            </div>
        </Modal>

        <!--
            Confirm shown only when there's something to lose: a busy session, or a bulk kill the gesture never named. Each row shows what that
            terminal is doing, the only thing distinguishing look-alike pills.
        -->
        <ConfirmDialog
            :open="pendingKill !== undefined"
            :header="killHeader"
            confirm-label="Kill anyway"
            confirm-icon="trash"
            :items="pendingKillItems"
            @cancel="pendingKill = undefined"
            @confirm="confirmKill"
        >
            <template #item="{ item }">
                <Icon :name="segmentIcon(item.name)" class="shrink-0 text-2xs text-muted" />
                <span class="shrink-0 text-content">{{ segmentLabel(item.name) }}</span>
                <span v-if="item.command" class="truncate font-mono text-xs text-muted">{{ item.command }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">{{ killBody }}</p>
        </ConfirmDialog>

        <!-- One dialog for both pickers (color, icon); a leading default swatch clears the override. Rename stays inline in the strip. -->
        <Modal :open="customize !== undefined" size="sm" :header="customizeHeader" @update:open="customize = undefined">
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
                        :class="ui.iconButton(`h-8 w-8`, terminalMeta(customize.name).icon === icon ? `bg-overlay text-content` : ``)"
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
/*
 * Split cells (plain elements from useTerminal's mount, hence :deep): equal flex columns with a hairline between, and a
 * top accent marking the focused pane in a split.
 */
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
</style>
