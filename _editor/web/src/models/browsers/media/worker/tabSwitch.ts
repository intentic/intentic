import type { DecodeSeams, Painter, StillPicture, Surface } from "./decodeSeams";
import { stillCache } from "../stillCache";

// AN INSTANT TAB SWITCH, IN THE DECODE WORKER. The tab picked in the strip is shown at once from its last picture
// (stillCache.ts), since the live one is a round trip away: the strip's `bind`, Chromium bringing the tab in front,
// its first paint, castd, the decoder. Frames keep decoding meanwhile, drawn onto a canvas of the worker's own behind
// the still, since until Chromium has switched they are of the tab being left; once the window says the tab is in
// front, the first frame captured a little after that puts the live picture back, or HOLD_MAX_MS does, whichever is
// first.

// How long after the window says the tab is in front a frame must be captured to show it (Chromium's first paint of
// it), and the most a still is held whatever happens.
const SETTLE_MS = 50;
const HOLD_MAX_MS = 500;

/** The canvas as the tab switch needs it: what it is, what draws on it, and whether it shows anything yet. */
export interface ShownCanvas {
    readonly surface: Surface;
    readonly painter: Painter;
    readonly drawn: boolean;
}

export interface TabSwitch {
    // Where a frame is drawn now: the back canvas during a hold, else undefined for the canvas itself.
    readonly painter: () => Painter | undefined;
    // A frame captured at `captureMs` (castd's clock) was drawn: the hold ends if it shows the new tab.
    readonly drew: (captureMs: number) => void;
    // The tab shown is `key`; `switching` when the person picked it.
    readonly show: (key: string, switching: boolean) => void;
    // The window says `key` is in front now, at `castdNow` on castd's clock.
    readonly fronted: (key: string, castdNow: number) => void;
    // Draws the shown tab's last picture on a canvas that has nothing yet; true when there was one.
    readonly paintBlank: () => boolean;
    readonly tick: () => void;
    // The picture is going (another window): its tab's last picture is kept.
    readonly leave: () => void;
    readonly release: () => void;
}

export const tabSwitch = (
    seams: Pick<DecodeSeams, `surface` | `snapshot` | `now`>,
    canvas: () => ShownCanvas | undefined,
    size: (width: number, height: number) => void,
): TabSwitch => {
    const stills = stillCache<StillPicture>();
    let shown: string | undefined;
    let hold: { readonly key: string; readonly back: Surface; readonly painter: Painter; readonly since: number; threshold?: number } | undefined;

    const release = (): void => {
        const held = hold;
        hold = undefined;
        if (held !== undefined) {
            canvas()?.painter.drawImage(held.back, 0, 0);
        }
    };

    const keep = (key: string | undefined): void => {
        const now = canvas();
        if (key !== undefined && now !== undefined && now.drawn) {
            void seams.snapshot(now.surface).then((still) => still !== undefined && stills.put(key, still));
        }
    };

    const paint = (key: string): boolean => {
        const still = stills.take(key);
        const now = canvas();
        if (still === undefined || now === undefined) {
            return false;
        }
        if (!now.drawn) {
            size(still.width, still.height);
        }
        now.painter.drawImage(still, 0, 0, now.surface.width, now.surface.height);
        return true;
    };

    const switchTo = (key: string): void => {
        release();
        keep(shown);
        shown = key;
        const now = canvas();
        if (now === undefined || !now.drawn) {
            paint(key);
            return;
        }
        // The live picture goes on behind the still, so what of it arrives during the hold is on the canvas after.
        const back = seams.surface(now.surface.width, now.surface.height);
        const painter = back?.getContext(`2d`) ?? undefined;
        if (back === undefined || painter === undefined) {
            return;
        }
        painter.drawImage(now.surface, 0, 0);
        if (paint(key)) {
            hold = { key, back, painter, since: seams.now() };
        }
    };

    return {
        painter: () => hold?.painter,
        drew: (captureMs) => {
            if (hold !== undefined && ((hold.threshold !== undefined && captureMs >= hold.threshold) || seams.now() - hold.since >= HOLD_MAX_MS)) {
                release();
            }
        },
        show: (key, switching) => {
            // A state naming another tab while the person's pick is held lagged the pick: taken, a still is misfiled.
            if (key === shown || (!switching && hold !== undefined)) {
                return;
            }
            if (switching) {
                switchTo(key);
                return;
            }
            // The window moved to another tab by itself (the agent): nothing to hold, the frames show it already.
            shown = key;
            if (canvas()?.drawn === false) {
                paint(key);
            }
        },
        fronted: (key, castdNow) => {
            // The first word only: the window says it again in every state after, which would push the threshold on.
            if (hold !== undefined && hold.key === key && hold.threshold === undefined) {
                hold.threshold = castdNow + SETTLE_MS;
            }
        },
        paintBlank: () => shown !== undefined && paint(shown),
        tick: () => {
            if (hold !== undefined && seams.now() - hold.since >= HOLD_MAX_MS) {
                release();
            }
        },
        leave: () => {
            release();
            keep(shown);
            shown = undefined;
        },
        release,
    };
};
