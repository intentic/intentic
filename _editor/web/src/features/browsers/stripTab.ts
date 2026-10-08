import type { IconName } from "@intentic/ui";

// One tab of the Browsers strip, whatever it is of: a web page of the window in front, or one of the reader's pins (a
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
}
