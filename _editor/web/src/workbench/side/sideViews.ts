import type { Disposable } from "@intentic/extension-api";
import type { IconName, Tip } from "@intentic/ui";
import { type Component, computed, shallowRef } from "vue";
import { handOffToMainWindow } from "../window/mainWindow";
import { type OpenBesideOptions, openBeside, type SideInput, type SideTab, sideDocked, sideTabId, useSidePanel } from "./sideTabs";

// WHAT THE SIDE PANEL CAN SHOW, one entry per side view: the core's own (a file, the running app) and each extension's.
// The panel draws a tab from `describe`, mounts `component` with the tab's input, and offers `home` as "Open in …".
// Registered from outside (coreSideViews.ts, the extension host), so this module, like the tab store, imports no feature.

/** What a tab says about the thing it shows: its name, its glyph, and what hovering it explains. */
export interface SideViewLabel {
    readonly title: string;
    readonly icon: IconName;
    // Extra classes for the glyph (a file's type colour); absent draws it in the strip's own ink.
    readonly iconClass?: string;
    // The hover card; absent, the tab's title is its whole hover.
    readonly tip?: Tip;
}

/** Where "Open in …" takes the thing, and what that button calls the place. */
export interface SideHome {
    readonly label: string;
    readonly open: () => void;
}

export interface SideViewEntry {
    // A core side view's own name (`file`, `preview`), or `<extension id>/<side view id>`.
    readonly id: string;
    // `builtin`, or the extension that registered it; an extension's go when it deactivates.
    readonly owner: string;
    // The family's name, for a tab whose own `describe` failed.
    readonly label: string;
    // Read on every render of the strip: a lookup, never a fetch. Throwing falls back to `label`.
    readonly describe: (input: SideInput) => SideViewLabel;
    // Absent (or undefined, so an entry is one literal) offers no "Open in …".
    readonly home?: ((input: SideInput) => SideHome | undefined) | undefined;
    // A link this side view can show instead of the browser opening it: the input it would open for `url`, or
    // undefined. Asked only when a link is followed, so it may parse, but it never fetches.
    readonly claim?: ((url: string) => SideInput | undefined) | undefined;
    // What the tab keeps of an input it is opened on, after acting on the rest: the preview selects the target a claimed
    // link names and keeps its one tab. Absent, the tab keeps the input as given.
    readonly opening?: (input: SideInput) => SideInput;
    // Opened kept, never as a peek: a live thing (the running app) the next link followed must not replace.
    readonly kept?: true;
    // Rendered with `input` (and `jump`, for a view that scrolls to a line) bound.
    readonly component: () => Promise<Component>;
    // Whether the main area is showing this very thing right now (the preview while you stand on /preview): its tab
    // steps aside until the main area lets go of it, rather than showing an empty frame.
    readonly lent?: () => boolean;
}

// allow(module-state): what side views exist is the app's and its extensions', not one sandbox's
const entries = shallowRef<readonly SideViewEntry[]>([]);

// A second registration of one id replaces the first in place: an extension activated again (a language change) is the
// same side view.
export const registerSideView = (entry: SideViewEntry): Disposable => {
    const others = entries.value.filter((existing) => existing.id !== entry.id);
    entries.value = [...others, entry];
    return {
        dispose: (): void => {
            entries.value = entries.value.filter((existing) => existing !== entry);
        },
    };
};

export const sideViewOf = (id: string): SideViewEntry | undefined => entries.value.find((entry) => entry.id === id);

// A tab's words, contained: an extension's describe that throws costs its own tab's title, never the strip.
export const describeTab = (tab: SideTab): SideViewLabel | undefined => {
    const entry = sideViewOf(tab.view);
    if (entry === undefined) {
        return undefined;
    }
    try {
        return entry.describe(tab.input);
    } catch (error) {
        console.warn("Could not describe a side view", error);
        return { title: entry.label, icon: `extensions` };
    }
};

// Where a tab's "Open in …" goes, contained the same way.
export const homeOf = (tab: SideTab): SideHome | undefined => {
    try {
        return sideViewOf(tab.view)?.home?.(tab.input);
    } catch (error) {
        console.warn("Could not resolve a side view home", error);
        return undefined;
    }
};

// The side view that claims a followed link, and the input it would open. The first claim wins, in registration
// order, which puts the core's own ahead of every extension's.
export const claimLink = (url: string): { readonly view: string; readonly input: SideInput } | undefined => {
    for (const entry of entries.value) {
        let input: SideInput | undefined;
        try {
            input = entry.claim?.(url);
        } catch {
            input = undefined;
        }
        if (input !== undefined) {
            return { view: entry.id, input };
        }
    }
    return undefined;
};

// Opens a side view where this window can show it: beside the section, with a side panel (a popped-out chat has its own);
// in the app's own window, from a popped-out panel with none; in its home otherwise (a phone). Answers whether it could
// be shown at all, so a claimed link that can't be shows as the link it was.
export const revealSideView = (view: string, input: SideInput, options: OpenBesideOptions = {}): boolean => {
    // Before `opening`, which acts on this window's own state (the preview's target), the errand being the other's.
    if (!sideDocked.value && handOffToMainWindow({ kind: `side`, view, input, keep: options.keep === true })) {
        return true;
    }
    const entry = sideViewOf(view);
    const kept = entry?.opening?.(input) ?? input;
    if (sideDocked.value) {
        openBeside(view, kept, entry?.kept === true ? { ...options, keep: true } : options);
        return true;
    }
    const home = homeOf({ id: sideTabId(view, kept), view, input: kept });
    home?.open();
    return home !== undefined;
};

const panel = useSidePanel();

// The tabs the strip draws: every tab but one whose thing the main area is showing right now. A tab whose side view is
// not registered (yet, or any more) still draws, so it can say so and be closed.
export const shownSideTabs = computed<readonly SideTab[]>(() => panel.tabs.value.filter((tab) => sideViewOf(tab.view)?.lent?.() !== true));

// The tab on screen: the one focused, unless it stepped aside, then the last one still drawn.
export const shownSideActive = computed<string | undefined>(() => {
    const shown = shownSideTabs.value;
    return shown.find((tab) => tab.id === panel.active.value)?.id ?? shown.at(-1)?.id;
});
