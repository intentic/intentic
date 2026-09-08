/* THE APP'S TOP ROW, READ AS A TITLE BAR — the questions the desktop app's frameless window asks of it.
 *
 * Inside the desktop app this window has no platform frame (desktop-app windows.rs): the strip that carried a
 * logo and three buttons is gone, and the row the app already draws across the top of every column
 * (`.view-header`, see styles.css) is the bar those buttons live in instead. That makes the row responsible
 * for three things a title bar does and a row of controls does not — being draggable, leaving the window's
 * own buttons somewhere to sit, and LOOKING like the top of a window: the bars standing in the top row wear
 * a fill darker than anything under them and a shadow onto it (`data-title-bar`), so the row reads as one bar
 * however many columns it is made of.
 *
 * Every answer is computed against the LIVE geometry rather than declared by a component, and that is the
 * point of this file. Which bars are in the top row changes with the layout — the chat's switcher while the
 * chat is docked, the editor's tab row once it is popped out or homed on the rail, an agent's detail row, a
 * route this file has never heard of, an extension's own view — and a rule each of those had to remember is a
 * rule that is wrong in whichever one was written last. A press is on the bar or it is not; a bar stands in the
 * top row or it does not; a bar ends at the window's right edge or it does not. */

/** A press on the row's own background, and what the window does about it. */
export type TitleBarGesture = "drag" | "maximize";

/* ANYTHING THE PRESS COULD HAVE BEEN MEANT FOR. The row is full of controls — tabs, a switcher, icon buttons,
 * the rename field — and a press that lands on one of them belongs to that control and never to the window.
 * `[data-window-no-drag]` is the opt-out for anything that is none of these and still owns its own pointer
 * (the window buttons' own strip wears it). */
const CONTROLS = `a, button, input, select, textarea, label, summary, [role="button"], [role="tab"], [contenteditable="true"], [data-window-no-drag]`;

/** Every bar of the app's top row, as one selector: `.view-header` is the class that makes them one row. */
export const BAR = `.view-header`;

/* THE BAR OF LAST RESORT: the strip WindowControls.vue draws across the top of a screen that has no bar in its
 * top row — the login page, the sandbox gate, an error state. It is a title bar in every sense that matters
 * here (it drags, it maximises on a double press, it wears the title fill) and in none of the others: nothing
 * stands in it, so it never has to reserve room for the buttons, and it exists only while no real bar does. */
export const STRIP = `.window-titlebar`;

/** What a bar standing in the top row wears, and what styles.css paints the title fill and shadow on. */
export const TITLE_BAR = `data-title-bar`;

/* How far from an edge a bar may sit and still count as being ON it. Bars are flush against the window; this
 * slack is for a fractional pixel at a scaled display's rounding, not for a bar that is nearly there. */
const EDGE_SLACK = 2;

/* WHICH GESTURE A PRESS IS, IF IT IS ONE AT ALL.
 *
 * Three things have to hold, and each rules out a real press: the press is on a bar (or on the strip standing
 * in for one), it is not on something in the bar, and the bar is the one at the TOP of the window. That last
 * one is why this takes geometry — `.view-header` is worn by every bar in the app, including the terminal
 * panel's at the bottom of the screen and a detail row halfway down it, and dragging the whole window by one of
 * those would be nonsense.
 *
 * A double press is the platform's own "maximise this window", which people do to a title bar without ever
 * having been told they can. */
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

/* THE BARS STANDING IN THE WINDOW'S TOP ROW — the ones that ARE the title bar, and so the ones that wear its
 * fill. Geometry rather than a class, for the reason given at the top: the terminal panel's bar and an agent's
 * detail row wear `.view-header` too, and a fill on those would be a title bar halfway down the window.
 *
 * Empty is an ordinary answer: a screen with no bar in its top row (a login page, a gate) is one the strip
 * stands in for (`STRIP`). */
export const topRow = <Bar>(bars: readonly Bar[], edgesOf: (bar: Bar) => BarEdges): Bar[] => bars.filter((bar) => edgesOf(bar).top <= EDGE_SLACK);

/* THE BAR THE WINDOW'S BUTTONS ARE ABOUT TO COVER: the one in the top row that ends at the window's right
 * edge. It is asked for so that bar can reserve the room, because the alternative is three buttons drawn over
 * whatever that bar already had there — which in the app's default layout is the chat's own four.
 *
 * `undefined` is an ordinary answer, not a failure: a screen with no bar at the top right has nothing to
 * reserve, and the buttons stand on the strip instead. */
export const edgeBar = <Bar>(bars: readonly Bar[], edgesOf: (bar: Bar) => BarEdges, width: number): Bar | undefined =>
    topRow(bars, edgesOf).find((bar) => edgesOf(bar).right >= width - EDGE_SLACK);
