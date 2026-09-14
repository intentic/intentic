/* THE APP'S TOP ROW, READ AS A TITLE BAR — the questions the desktop app's frameless window asks of it. */

/** A press on the row's own background, and what the window does about it. */
export type TitleBarGesture = "drag" | "maximize";

/* ANYTHING THE PRESS COULD HAVE BEEN MEANT FOR. */
const CONTROLS = `a, button, input, select, textarea, label, summary, [role="button"], [role="tab"], [contenteditable="true"], [data-window-no-drag]`;

/** Every bar of the app's top row, as one selector: `.view-header` is the class that makes them one row. */
export const BAR = `.view-header`;

/* THE BAR OF LAST RESORT: the strip WindowControls.vue draws across the top of a screen that has no bar in its top row — the login page, the sandbox gate. */
export const STRIP = `.window-titlebar`;

/** What a bar standing in the top row wears, and what styles.css paints the title fill and shadow on. */
export const TITLE_BAR = `data-title-bar`;

/* How far from an edge a bar may sit and still count as being ON it. */
const EDGE_SLACK = 2;

/* A title-bar press must target the bar or its proxy, not a child control. */
export const titleBarGesture = (target: Element | null, clicks: number, topOf: (bar: Element) => number): TitleBarGesture | undefined => {
    const bar = target?.closest(`${BAR}, ${STRIP}`) ?? null;
    if (bar === null || target?.closest(CONTROLS) !== null) {
        return undefined;
    }
    if (topOf(bar) > EDGE_SLACK) {
        return undefined;
    }
    return clicks >= 2 ? `maximize` : `drag`;
};

/** As much of a bar's box as any question here needs. */
export interface BarEdges {
    readonly top: number;
    readonly right: number;
}

/* Top-row bars stand in for the desktop title bar. */
export const topRow = <Bar>(bars: readonly Bar[], edgesOf: (bar: Bar) => BarEdges): Bar[] => bars.filter((bar) => edgesOf(bar).top <= EDGE_SLACK);

/* The edge bar is the top-row bar reaching the window's right edge. */
export const edgeBar = <Bar>(bars: readonly Bar[], edgesOf: (bar: Bar) => BarEdges, width: number): Bar | undefined =>
    topRow(bars, edgesOf).find((bar) => edgesOf(bar).right >= width - EDGE_SLACK);
