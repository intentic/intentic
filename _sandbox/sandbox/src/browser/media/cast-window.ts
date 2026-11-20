import { pollUntil } from "@intentic/base/async";
import { BROWSER_MEDIA_PATH } from "@intentic/sandbox-contract/browser-wire";
import type { Workload } from "../../workload/workload-class.js";
import { releaseWindowSound, windowSoundOf } from "./cast-audio.js";
import { type Castd, castdDir, type CastFraming, type CastGeometry, castdOf, ensureCastd, stopCastd } from "./castd.js";
import { type Display, onDisplayRelease, WINDOW_HEIGHT, WINDOW_WIDTH } from "../cast/display.js";
import type { Size } from "../cast/emulation.js";
import { fitWindows, type ScaleSetting, screenChanges, startScaleSetting } from "./screen-fit.js";

/* A window's display as castd serves it, with what the daemon does around castd: its sound, and for a window that is
   its screen (a kiosk the daemon launched) the fit and the pixel ratio (screen-fit.ts). One per display key, made the
   first time a view of the window opens (live-view.ts), ended with the display. */

// How often a watched screen's geometry is read for a change the daemon must answer (a viewer's resize or pixel ratio,
// which castd hears on the media socket and the daemon does not): the window's fit and XSETTINGS lag a resize by at
// most this. Read only while a view is open, so an unwatched window costs nothing.
const FOLLOW_MS = 400;

export interface CastWindow {
    readonly castd: Castd;
    // Resolves once castd answers and the screen is set up after its start (held at a box, the window fitted to it):
    // what a viewer is handed the media socket after, so its first picture is the window's.
    readonly ready: () => Promise<boolean>;
    // The media socket's path on the sandbox's address: browser-wire's media path and castd's session.
    readonly path: string;
    // Keeps the screen followed while the returned release is not called: one per open view.
    readonly watch: () => () => void;
    // Holds the screen at a phone's size (CSS px, at the scale castd has now), or lets it go back to the viewers' box.
    readonly phone: (size: { readonly width: number; readonly height: number } | undefined) => Promise<void>;
    // Makes the browser's windows cover the screen as it is now: a window just put back into fullscreen.
    readonly fit: () => Promise<void>;
}

interface Entry extends CastWindow {
    readonly stop: () => void;
}

const windows = new Map<string, Entry>();

// The screen castd makes of a box at a scale: display pixels, rounded, even on both sides (castd's screen.rs `fit`).
const screenFor = (box: Size, scale: number): Size => ({
    width: Math.round(box.width * scale) - (Math.round(box.width * scale) % 2),
    height: Math.round(box.height * scale) - (Math.round(box.height * scale) % 2),
});

// After castd starts: the screen held at `pinned` (a phone), else at the window's default box until a viewer asks for
// its own, and the browser's windows fitted to it. castd's capture thread applies a size between frames, so the screen
// is read until it has the box, and the windows fitted to the screen it really has.
const holdAndFit = async (display: Display, castd: Castd, pinned: Size | undefined): Promise<CastGeometry | undefined> => {
    const at = (await castd.control.geometry())?.scale ?? 1;
    const box = pinned ?? { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
    await castd.control.pin({ ...box, scale: at });
    if (pinned === undefined) {
        await castd.control.unpin();
    }
    const asked = screenFor(box, at);
    let after: CastGeometry | undefined;
    await pollUntil(
        async () => {
            after = await castd.control.geometry();
            return after?.screen.width === asked.width && after.screen.height === asked.height;
        },
        { intervalMs: 50, timeoutMs: 2_000 },
    );
    if (after !== undefined) {
        await fitWindows(display.name, after.screen);
    }
    return after;
};

const followScreen = (display: Display, castd: Castd): Pick<Entry, "watch" | "phone" | "stop" | "ready" | "fit"> => {
    let watchers = 0;
    let seen: CastGeometry | undefined;
    let timer: NodeJS.Timeout | undefined;
    let scale: ScaleSetting | undefined;
    let pinned: { readonly width: number; readonly height: number } | undefined;

    const look = async (): Promise<void> => {
        const now = await castd.control.geometry();
        if (now === undefined) {
            return;
        }
        const changed = screenChanges(seen, now);
        seen = now;
        if (changed.scale) {
            scale ??= startScaleSetting(display.name, castd.session, castdDir(), now.scale);
            scale?.set(now.scale);
        }
        if (changed.fit) {
            await fitWindows(display.name, now.screen);
        }
    };

    // castd answers on a screen RandR set back to the display's full size (its modes went with the last castd): the
    // window is held at a box until a viewer asks for theirs, and made to cover it, since it covers no screen castd
    // would fit it from.
    const started = async (): Promise<void> => {
        seen = undefined;
        const after = await holdAndFit(display, castd, pinned);
        if (after !== undefined) {
            seen = after;
            if (after.xsettings !== true) {
                scale ??= startScaleSetting(display.name, castd.session, castdDir(), after.scale);
                scale?.set(after.scale);
            }
        }
    };
    // The latest start's setup, which `ready` waits on.
    let settled: Promise<void> = Promise.resolve();
    const unlisten = castd.onStarted(() => {
        settled = started();
    });

    return {
        ready: async () => {
            const up = await castd.ready();
            await settled;
            return up;
        },
        fit: async () => {
            const now = await castd.control.geometry();
            if (now !== undefined) {
                await fitWindows(display.name, now.screen);
            }
        },
        watch: () => {
            watchers += 1;
            if (timer === undefined) {
                timer = setInterval(() => void look(), FOLLOW_MS);
                timer.unref();
            }
            let released = false;
            return () => {
                if (released) {
                    return;
                }
                released = true;
                watchers -= 1;
                if (watchers === 0) {
                    clearInterval(timer);
                    timer = undefined;
                }
            };
        },
        phone: async (size) => {
            pinned = size;
            const at = (await castd.control.geometry())?.scale ?? 1;
            await (size === undefined ? castd.control.unpin() : castd.control.pin({ ...size, scale: at }));
            await look();
        },
        stop: () => {
            unlisten();
            clearInterval(timer);
            scale?.stop();
        },
    };
};

// A cropped window's castd: nothing to follow, since the daemon moves the crop itself as the window moves.
const followNothing = (castd: Castd): Pick<Entry, "watch" | "phone" | "stop" | "ready" | "fit"> => ({
    ready: () => castd.ready(),
    fit: async () => undefined,
    watch: () => () => undefined,
    phone: async () => undefined,
    stop: () => undefined,
});

// The window on `display` as castd serves it, castd started if it is not running; undefined without a castd binary,
// which leaves the window on the old path.
export const castWindow = (key: string, display: Display, framing: CastFraming, workload?: Workload): CastWindow | undefined => {
    const existing = windows.get(key);
    // The window's own crop is its view's to move (media-view.ts), never set back here by the next view to open. A key
    // whose display came back on another number (its X server died) is served afresh, as ensureCastd does.
    if (existing !== undefined && existing.castd.display === display.name && existing.castd.framing().kind === framing.kind && castdOf(key) === existing.castd) {
        return existing;
    }
    existing?.stop();
    windows.delete(key);
    const castd = ensureCastd({
        key,
        display: display.name,
        framing,
        maxSize: { width: display.width, height: display.height },
        audio: windowSoundOf(display.name, castdDir()),
        workload,
    });
    if (castd === undefined) {
        return undefined;
    }
    const followed = framing.kind === "screen" ? followScreen(display, castd) : followNothing(castd);
    const entry: Entry = { castd, path: `${BROWSER_MEDIA_PATH}/${castd.session}`, ...followed };
    windows.set(key, entry);
    return entry;
};

// The display is going: its castd, its pixel ratio and its sink go with it.
onDisplayRelease((key, display) => {
    windows.get(key)?.stop();
    windows.delete(key);
    stopCastd(key);
    void releaseWindowSound(display.name, castdDir());
});
