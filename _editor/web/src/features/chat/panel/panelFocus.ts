// What the chat panels on the page drew, read back off the page, against the chat the tab store focuses: the decision half
// of panelFocusWatch.ts, kept free of the store and the DOM so it can be pinned on its own.

/** One `.chat-panel` element on the page, as the watch reads it. */
export interface DrawnPanel {
    /** The chat it last drew as its focused one (its `data-chat-focus`). */
    readonly focus: string | undefined;
    /** A ChatPanel this window mounted, and has not unmounted, owns it. An element nobody owns is a leftover. */
    readonly live: boolean;
    /** Laid out where a reader can see it: not parked off the page, not folded to nothing. */
    readonly onScreen: boolean;
}

export interface PanelVerdict {
    /** Panels on screen that still draw another chat than the focused one. */
    readonly stale: number;
    /** Panel elements that no mounted ChatPanel owns. */
    readonly orphans: number;
}

export const panelVerdict = (focused: string, panels: readonly DrawnPanel[]): PanelVerdict => ({
    stale: panels.filter((panel) => panel.live && panel.onScreen && panel.focus !== focused).length,
    orphans: panels.filter((panel) => !panel.live).length,
});

export const panelsAgree = (verdict: PanelVerdict): boolean => verdict.stale === 0 && verdict.orphans === 0;

/**
 * What puts a stuck verdict right, in order:
 * - `drop-orphans`: a panel's markup that outlived its component is removed, since nothing will ever redraw it
 * - `refocus`: the store focuses a chat it holds no tab for, so the panel is right to draw its floor and the focus moves
 *   to an open chat instead
 * - `remount`: a live panel that stopped following an open chat is built again
 */
export type PanelRepair = `drop-orphans` | `refocus` | `remount`;

export const repairsFor = (verdict: PanelVerdict, focusOpen: boolean): readonly PanelRepair[] => [
    ...(verdict.orphans > 0 ? ([`drop-orphans`] as const) : []),
    ...(verdict.stale > 0 ? [focusOpen ? (`remount` as const) : (`refocus` as const)] : []),
];

/** The panels in one line for a report: what each drew, whether anything owns it, whether it shows. */
export const describePanels = (panels: readonly DrawnPanel[]): string =>
    panels.map((panel) => `${panel.focus ?? `none`}:${panel.live ? `live` : `orphan`}:${panel.onScreen ? `shown` : `hidden`}`).join(` `);
