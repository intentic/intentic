import type { IconName } from "@intentic/ui";

// One tab of the Browsers strip, whatever it is of: a web page of one of the open windows, or one of the reader's pins (a
// live app, the desktop, a window on it). What kind of thing a tab is shows in its glyph and the glyph's colour, never in
// words beside the title: a tab's width is the title's.
export interface StripTab {
    // Unique within the strip; what `pick` and `close` hand back.
    readonly id: string;
    readonly label: string;
    // The hover's second line: an address, or a state worth a sentence.
    readonly note?: string | undefined;
    readonly icon: IconName;
    // What the glyph says, for a reader who cannot see it: spoken after the title, never drawn.
    readonly kind?: string | undefined;
    // A colour for the glyph, where the kind has a state to show (a live app running, starting, stopped).
    readonly tint?: string | undefined;
    // The glyph turns while the tab is on its way (an app starting, a page loading).
    readonly spin?: boolean | undefined;
    readonly closable: boolean;
    // Pins sit before the web pages, set off by a hairline; the strip draws the seam where the group changes.
    readonly pinned: boolean;
    // The window a web page lives in, when the strip names whose tabs are whose: its tabs run together behind one label.
    readonly group?: StripGroup | undefined;
}

// One window's run of tabs on the strip: the label before its first tab, which says whose window it is and puts it in
// front. Every window's pages are on the strip at once, so opening a tab in one never makes another's disappear.
export interface StripGroup {
    // Stable for the life of the window; what `pickGroup` hands back.
    readonly id: string;
    readonly label: string;
    // The hover's second line: who has the window now, its account, how many tabs.
    readonly note?: string | undefined;
    // The state dot's colour: asking for help, an agent at work in it, or simply open.
    readonly dot: string;
    // The window whose page is in front.
    readonly current: boolean;
}

// What the strip draws, in order: every tab, and before the first tab of a labelled window, that window's label. Where
// one run ends and the next begins (the pins and the web pages, one window and the next) a hairline sets them apart,
// drawn on whatever starts the new run.
export type StripItem =
    | { readonly kind: `label`; readonly key: string; readonly group: StripGroup; readonly seam: boolean }
    | { readonly kind: `tab`; readonly key: string; readonly tab: StripTab; readonly seam: boolean };

export const stripItems = (tabs: readonly StripTab[]): StripItem[] =>
    tabs.flatMap((tab, index): StripItem[] => {
        const before = tabs[index - 1];
        const seam = before !== undefined && (before.pinned !== tab.pinned || before.group?.id !== tab.group?.id);
        if (tab.group === undefined || tab.group.id === before?.group?.id) {
            return [{ kind: `tab`, key: tab.id, tab, seam }];
        }
        return [
            { kind: `label`, key: `group:${tab.group.id}`, group: tab.group, seam },
            { kind: `tab`, key: tab.id, tab, seam: false },
        ];
    });
