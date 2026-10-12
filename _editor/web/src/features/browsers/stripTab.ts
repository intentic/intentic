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
    // What the strip knows the tab by across renders, when not its id: a tab that arrives in the place of the one drawn
    // while it was on its way takes that one's, so it is the same tab filled in rather than one folding away as another
    // grows in beside it.
    readonly key?: string | undefined;
}

// One window's run of tabs on the strip: the mark before its first tab, which says whose window it is and puts it in
// front. Every window's pages are on the strip at once, so opening a tab in one never makes another's disappear.
export interface StripGroup {
    // Stable for the life of the window; what `pickGroup` hands back.
    readonly id: string;
    // Whose window, in full: said on hover and to a screen reader, never drawn on the strip, where a name ran longer than
    // the tabs it stood over.
    readonly label: string;
    // The hover's second line: who has the window now, its account, how many tabs.
    readonly note?: string | undefined;
    // What the strip draws for the window: a glyph (the person's own, an agent known by no name) or one letter.
    readonly mark: GroupMark;
    // A state worth a glance, as a dot's colour: asking for help, or an agent at work in it. None for a window simply
    // open, which is most of them, so the strip stays quiet until something wants the reader.
    readonly dot?: string | undefined;
    // The window whose page is in front.
    readonly current: boolean;
}

export type GroupMark = { readonly kind: `icon`; readonly icon: IconName } | { readonly kind: `initial`; readonly letter: string };

// A name's first letter or digit, upper-cased, skipping the punctuation and emoji a conversation's title may open with;
// undefined for a name with none.
export const initialOf = (name: string): string | undefined => [...name].find((char) => /[\p{L}\p{N}]/u.test(char))?.toLocaleUpperCase();

// What the strip draws, in order: every tab, and before the first tab of a labelled window, that window's mark. Where
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
            return [{ kind: `tab`, key: tab.key ?? tab.id, tab, seam }];
        }
        return [
            { kind: `label`, key: `group:${tab.group.id}`, group: tab.group, seam },
            { kind: `tab`, key: tab.key ?? tab.id, tab, seam: false },
        ];
    });
