import { sandboxRef, sandboxValue } from "@intentic/extension-api";
import { computed, ref, watch } from "vue";
import { z } from "zod";
import { activeSandboxId } from "../../features/sandbox/overview/activeSandbox";
import type { LineJump } from "../../features/workspace/tabs/workspaceTabs";
import { readWindowState, writeWindowState } from "../window/windowStore";

// THE SIDE PANEL'S TABS: what the reader opened beside the section the rail put in the main area. Each tab shows one
// side view (a file, the running app, an extension's view of one thing) on one input. A tab opened from a link is a
// peek, the one the next link replaces unless it is kept; the docked chat is not a tab, it lives under them
// (SidePanel.vue). Nothing here imports a feature, so any feature can open something beside without a module cycle.

/** What one side view is opened on: plain values only, since the tab survives a reload and travels between windows. */
export type SideInput = Readonly<Record<string, string | number | boolean>>;

export interface SideTab {
    // `view` and `input` together, so opening the same thing twice finds the tab it already has.
    readonly id: string;
    // A built-in side view (`file`, `preview`) or an extension's, as `<extension id>/<side view id>`.
    readonly view: string;
    readonly input: SideInput;
}

interface SideState {
    readonly tabs: readonly SideTab[];
    readonly active: string | null;
    // The tab opened as a look, which the next look replaces unless it is kept; null once kept or closed.
    readonly peek: string | null;
    // The tabs folded down to their strip, giving the chat under them the height. Opening anything unfolds them.
    readonly collapsed: boolean;
}

export interface OpenBesideOptions {
    // An ordinary tab from the start, not a peek: a deliberate open rather than a link followed.
    readonly keep?: boolean;
    // Where a view that scrolls (a file) lands; not part of what the tab is, so a second line refocuses the same tab.
    readonly line?: number;
}

const EMPTY: SideState = { tabs: [], active: null, peek: null, collapsed: false };

// Keys sorted, so `{a, b}` and `{b, a}` are one tab.
export const sideTabId = (view: string, input: SideInput): string =>
    JSON.stringify([view, Object.entries(input).toSorted(([left], [right]) => left.localeCompare(right))]);

// --- Persistence -----------------------------------------------------------------------------------------------
// Per window and per sandbox, like the workspace's tab strip: a path names a file in one sandbox's /work, and two windows
// may be looking at different things. The id is captured at restore rather than read at write, since the active sandbox
// flips before this scope re-reads its state.

// A popped-out chat's panel is its own: the window starts with a copy of its opener's session storage, which would
// otherwise hand it the main window's tabs. Read once, since a window never changes which kind it is.
const floatingWindow = globalThis.location?.pathname.startsWith(`${import.meta.env.BASE_URL}floating/`) === true;
const storageKey = (sandboxId: string): string => (floatingWindow ? `intentic.sidePanel.floating.${sandboxId}` : `intentic.sidePanel.${sandboxId}`);

// A side view's input as it may arrive from outside the app's own code (a stored tab, an extension's call): plain values.
export const SideInputSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

const StoredTabSchema = z.object({
    view: z.string().min(1),
    input: SideInputSchema,
});

// Each tab is read on its own below, so one unreadable tab costs itself rather than the whole panel.
const StoredStateSchema = z.object({
    tabs: z.array(z.unknown()),
    active: z.string().nullish(),
    peek: z.string().nullish(),
    collapsed: z.boolean().optional(),
});

// An unreadable payload counts as nothing remembered; the panel opens empty.
const readStored = (raw: string): z.infer<typeof StoredStateSchema> | undefined => {
    try {
        return StoredStateSchema.safeParse(JSON.parse(raw)).data;
        // allow(silent-catch): Malformed stored JSON restores an empty panel, never unchecked tabs.
    } catch {
        return undefined;
    }
};

// Drops a second copy of a tab, which would collide on its key, and any focus naming a tab that did not survive.
const parseState = (raw: string): SideState | undefined => {
    const stored = readStored(raw);
    if (stored === undefined) {
        return undefined;
    }
    const tabs: SideTab[] = [];
    for (const entry of stored.tabs) {
        const parsed = StoredTabSchema.safeParse(entry).data;
        if (parsed === undefined) {
            continue;
        }
        const id = sideTabId(parsed.view, parsed.input);
        if (!tabs.some((tab) => tab.id === id)) {
            tabs.push({ id, view: parsed.view, input: parsed.input });
        }
    }
    const names = (id: string | null | undefined): string | null => (tabs.some((tab) => tab.id === id) ? (id ?? null) : null);
    return { tabs, active: names(stored.active) ?? tabs.at(-1)?.id ?? null, peek: names(stored.peek), collapsed: stored.collapsed === true };
};

const scopedSandboxId = sandboxValue(() => activeSandboxId.value);
const restored = (): SideState =>
    (scopedSandboxId.value === undefined ? undefined : readWindowState(storageKey(scopedSandboxId.value), parseState)) ?? EMPTY;

const state = sandboxRef<SideState>(restored);
// Where each tab was last asked to land; seq bumps so the same line asked twice still scrolls. Not stored: a reload
// reopens a file at its top, as the workspace does.
const jumps = sandboxRef<Readonly<Record<string, LineJump>>>(() => ({}));
let jumpSeq = 0;

// Ids only, never the tabs' objects: a tab's identity is its id, so rewriting the list with equal tabs writes nothing.
const serialized = computed(() =>
    JSON.stringify({
        tabs: state.value.tabs.map(({ view, input }) => ({ view, input })),
        active: state.value.active,
        peek: state.value.peek,
        collapsed: state.value.collapsed,
    }),
);
watch(serialized, (json) => {
    if (scopedSandboxId.value !== undefined) {
        writeWindowState(storageKey(scopedSandboxId.value), json);
    }
});

// Whether this window has a side panel to open things in: the desktop shell of a main window, or a popped-out chat's
// window (FloatingSection.vue). A phone, and a popped-out terminal or preview, have none, and a reference there does
// what it did before the panel existed.
// allow(module-state): whether the desktop shell is mounted in this window, which no sandbox switch changes
export const sideDocked = ref(false);

// --- Opening and closing ---------------------------------------------------------------------------------------

const set = (next: Partial<SideState>): void => {
    state.value = { ...state.value, ...next };
};

// The tab the reader lands on once `closed` goes: the one to its right, else its left, else none.
const neighbourOf = (tabs: readonly SideTab[], closed: string): string | null => {
    const at = tabs.findIndex((tab) => tab.id === closed);
    return (tabs[at + 1] ?? tabs[at - 1])?.id ?? null;
};

// Opens a side view on an input, or focuses the tab already showing it. A peek replaces the peek before it in place, so
// following link after link reads as one tab changing, not a strip filling up.
export const openBeside = (view: string, input: SideInput, options: OpenBesideOptions = {}): void => {
    const id = sideTabId(view, input);
    const current = state.value;
    const open = current.tabs.some((tab) => tab.id === id);
    if (options.line !== undefined) {
        jumps.value = { ...jumps.value, [id]: { line: options.line, seq: ++jumpSeq } };
    }
    if (open) {
        set({ active: id, collapsed: false, peek: options.keep === true && current.peek === id ? null : current.peek });
        return;
    }
    const tab: SideTab = { id, view, input };
    const replacing = options.keep === true ? -1 : current.tabs.findIndex((candidate) => candidate.id === current.peek);
    const tabs = replacing === -1 ? [...current.tabs, tab] : current.tabs.with(replacing, tab);
    set({ tabs, active: id, collapsed: false, peek: options.keep === true ? (replacing === -1 ? current.peek : null) : id });
};

// Double-click, Keep open, or anything else that says the reader means to come back to it.
export const keepTab = (id: string): void => {
    if (state.value.peek === id) {
        set({ peek: null });
    }
};

export const activateTab = (id: string): void => {
    if (state.value.tabs.some((tab) => tab.id === id)) {
        set({ active: id, collapsed: false });
    }
};

export const closeTabs = (ids: ReadonlySet<string>): void => {
    const current = state.value;
    const tabs = current.tabs.filter((tab) => !ids.has(tab.id));
    if (tabs.length === current.tabs.length) {
        return;
    }
    let active = current.active;
    if (active !== null && ids.has(active)) {
        // Walks right then left from the closed focus, over the tabs that survive.
        const at = current.tabs.findIndex((tab) => tab.id === active);
        const right = current.tabs.slice(at + 1).find((tab) => !ids.has(tab.id));
        const left = current.tabs.slice(0, at).findLast((tab) => !ids.has(tab.id));
        active = (right ?? left)?.id ?? null;
    }
    const peek = current.peek !== null && ids.has(current.peek) ? null : current.peek;
    const kept = Object.fromEntries(Object.entries(jumps.value).filter(([id]) => !ids.has(id)));
    jumps.value = kept;
    set({ tabs, active, peek, collapsed: tabs.length === 0 ? false : current.collapsed });
};

export const closeTab = (id: string): void => closeTabs(new Set([id]));

export const closeOtherTabs = (id: string): void => closeTabs(new Set(state.value.tabs.filter((tab) => tab.id !== id).map((tab) => tab.id)));

export const closeAllTabs = (): void => closeTabs(new Set(state.value.tabs.map((tab) => tab.id)));

// Every tab showing a view, e.g. when an extension goes and takes its side view with it.
export const tabsOfView = (view: string): readonly SideTab[] => state.value.tabs.filter((tab) => tab.view === view);

export const setCollapsed = (collapsed: boolean): void => {
    set({ collapsed });
};

export const toggleCollapsed = (): void => setCollapsed(!state.value.collapsed);

// The next or previous tab, wrapping; Alt+PageDown and Alt+PageUp from inside the panel.
export const cycleTab = (step: 1 | -1, among: readonly SideTab[] = state.value.tabs): void => {
    if (among.length === 0) {
        return;
    }
    const at = among.findIndex((tab) => tab.id === state.value.active);
    const next = among[(at + step + among.length) % among.length];
    if (next !== undefined) {
        activateTab(next.id);
    }
};

export const useSidePanel = () => ({
    tabs: computed(() => state.value.tabs),
    active: computed(() => state.value.active),
    peek: computed(() => state.value.peek),
    collapsed: computed(() => state.value.collapsed),
    jumps: computed(() => jumps.value),
    neighbourOf: (id: string) => neighbourOf(state.value.tabs, id),
});
