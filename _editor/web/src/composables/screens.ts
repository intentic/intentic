/* THE SHAPE OF THE DESKTOP — how many screens there are, where each one's usable area sits, and which of them
 * the app itself is being read on. A page is told none of this by default: `window.screen` describes the screen
 * the tab happens to be on and nothing else, which is why a window opened for a second monitor has always been
 * a guess. The Window Management API answers properly, behind a permission.
 *
 * IT IS ASKED FOR ONCE, FROM THE GESTURE THAT NEEDS IT. The prompt is a real interruption, so nothing here
 * fires on load in the common case: a session where the reader never pops a panel out never sees it. The one
 * thing that DOES run at load is the silent half — a permission already granted on an earlier visit is read
 * back without a prompt, so the geometry is in hand before the first F9 and the window it opens is placed in
 * the same breath rather than jumping a beat later.
 *
 * EVERY ANSWER IS OPTIONAL, AND "DON'T KNOW" IS ONE OF THEM. A browser without the API, a reader who dismissed
 * the prompt, a policy that blocks it — all of them arrive here as `undefined`, which callers must read as
 * "place this the old way" rather than "there is one screen". Guessing the other direction is how a window ends
 * up on a monitor that isn't there. */

export interface ScreenRect {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
}

/* A screen as the API describes it: the desktop's own coordinate space, so `availLeft`/`availTop` place it
 * relative to the primary screen's origin and can be negative for a monitor to the left of it. The `avail`
 * measurements are the WORK area — what is left after the taskbar or dock — which is exactly what a window may
 * fill without hiding under anything. */
interface ScreenDetailed extends Screen {
    readonly availLeft: number;
    readonly availTop: number;
    readonly isPrimary: boolean;
    readonly isInternal: boolean;
}

// The live view the browser hands back: its arrays keep up with monitors being plugged in, unplugged or
// rearranged, so this is held rather than copied — a page open all day must not place windows by yesterday's
// desktop.
interface ScreenDetails {
    readonly screens: readonly ScreenDetailed[];
    readonly currentScreen: ScreenDetailed;
}

declare global {
    interface Window {
        readonly getScreenDetails?: () => Promise<ScreenDetails>;
    }
}

let details: ScreenDetails | undefined;
// The one attempt this page makes, in flight or settled. A dismissed prompt is an answer like any other: asking
// again on the next pop-out would turn a gesture the reader repeats all day into a nag.
let asking: Promise<void> | undefined;

const workArea = (screen: ScreenDetailed): ScreenRect => ({
    left: screen.availLeft,
    top: screen.availTop,
    width: screen.availWidth,
    height: screen.availHeight,
});

/** The screens' work areas, or `undefined` while the browser has not told us — see the note on "don't know". */
export const knownScreens = (): readonly ScreenRect[] | undefined => details?.screens.map(workArea);

/** The screen the app's own window is on. Undefined for the same reasons as above. */
export const appScreen = (): ScreenRect | undefined => (details === undefined ? undefined : workArea(details.currentScreen));

/* The screen to put something on when the reader has expressed no preference: the first one that is not the
 * app's. "First" is the order the browser lists them in, which is the desktop's own left-to-right arrangement —
 * predictable, and on the two-monitor desk this is for it is simply "the other one". Undefined when the app is
 * on the only screen there is. */
export const otherScreen = (): ScreenRect | undefined => {
    if (details === undefined) {
        return undefined;
    }
    const current = details.currentScreen;
    return details.screens.filter((screen) => screen !== current).map(workArea)[0];
};

const overlap = (frame: ScreenRect, screen: ScreenRect): number => {
    const horizontal = Math.min(frame.left + frame.width, screen.left + screen.width) - Math.max(frame.left, screen.left);
    const vertical = Math.min(frame.top + frame.height, screen.top + screen.height) - Math.max(frame.top, screen.top);
    return Math.max(0, horizontal) * Math.max(0, vertical);
};

/* Which screen a window belongs to, measured the way the window manager itself decides: the one it covers most
 * of. A window straddling two monitors has to be assigned to one of them, and the bigger half is the one the
 * reader would name. Undefined means it overlaps none of them — a frame left over from a monitor since
 * unplugged, whose coordinates now point at nothing — or that the desktop's shape was never learned, which the
 * caller passes in rather than this reaching for it: the geometry below is arithmetic, and only the knowledge
 * above it depends on what the browser was willing to say. */
export const screenHolding = (frame: ScreenRect, screens: readonly ScreenRect[] | undefined): ScreenRect | undefined => {
    if (screens === undefined) {
        return undefined;
    }
    let best: ScreenRect | undefined;
    let bestArea = 0;
    for (const screen of screens) {
        const area = overlap(frame, screen);
        if (area > bestArea) {
            best = screen;
            bestArea = area;
        }
    }
    return best;
};

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/* Shrink and shove a frame until it is wholly inside a screen's work area. THE SHRINK IS THE POINT: a window
 * carried to a smaller monitor (or one the desktop scales differently) keeps the pixel size it had on the big
 * one, which is how a chat ends up wider than the screen it was moved to with its own edges out of reach. */
export const fitInto = (frame: ScreenRect, screen: ScreenRect): ScreenRect => {
    const width = Math.min(frame.width, screen.width);
    const height = Math.min(frame.height, screen.height);
    return {
        width,
        height,
        left: clamp(frame.left, screen.left, screen.left + screen.width - width),
        top: clamp(frame.top, screen.top, screen.top + screen.height - height),
    };
};

/** Where something opens on a screen it has never been placed on: middle of the work area, cut down to fit it. */
export const centreIn = (screen: ScreenRect, size: { readonly width: number; readonly height: number }): ScreenRect => {
    const width = Math.min(size.width, screen.width);
    const height = Math.min(size.height, screen.height);
    return {
        width,
        height,
        left: screen.left + (screen.width - width) / 2,
        top: screen.top + (screen.height - height) / 2,
    };
};

/* Ask the browser to describe the desktop, prompting if it has not been asked before — so this belongs in a
 * user gesture, and the caller must keep working whether it resolves to knowledge or not. Resolves once the
 * answer is in, which is the moment a window opened a beat earlier can be moved to where it actually belongs. */
export const learnScreens = async (): Promise<void> => {
    const ask = window.getScreenDetails;
    if (details !== undefined || typeof ask !== `function`) {
        return; // already known, or a browser with nothing to ask — everyone but Chromium, today
    }
    asking ??= ask.call(window).then(
        (answer) => {
            details = answer;
        },
        // Refused, dismissed, or blocked by policy. Nothing is broken: windows are placed by the single screen
        // this page can measure, exactly as they were before.
        () => undefined,
    );
    return asking;
};

/* The silent half, run at load: a permission the reader granted on an earlier visit is already an answer, and
 * reading it back costs them nothing. Only `granted` is acted on — `prompt` is left for the gesture that needs
 * it, so nothing interrupts a session that never pops a panel out. */
if (typeof window !== `undefined`) {
    const permissions = navigator.permissions as Permissions | undefined;
    void permissions
        ?.query({ name: `window-management` as PermissionName })
        .then((status) => {
            if (status.state === `granted`) {
                void learnScreens();
            }
        })
        // A browser that doesn't know the name rejects rather than answering "no" — the same silence as above.
        .catch(() => undefined);
}
