import { BROWSER_MEDIA_PATH } from "@intentic/sandbox-contract/browser-wire";
import { type Castd, castdAvailable, castdMediaKey, castdOf, ensureCastd, stopCastd } from "../browser/media/castd.js";
import type { Display } from "../browser/cast/display.js";
import { mediaMessage, TOKEN_TTL_MS } from "../browser/media/media-view.js";
import type { Region } from "../browser/cast/region.js";
import { startXInput, type XInput } from "../browser/cast/xinput.js";
import { DESKTOP_KEY, OWNER_IDLE_MS, ownerDriving } from "./agent-desktop.js";

/* The desktop view on castd (desktop-view.ts), for a viewer that asked for it (`media=1`): the picture, the pointer and
   the keys travel on a media socket of the window's own, and the desktop view socket carries `media {path, token,
   expiresAt}` instead of video. The whole desktop is a castd cropped to the whole screen, so a viewer's box never
   resizes the screen the agent's programs are laid out on; one program's window is a castd of its own, cropped to the
   window and moved as the window moves.

   Owner control holds on: the token is read-only until this view takes the desktop, and a fresh one goes out at each
   change of hands, which the viewer reconnects with. At each change castd first ends every read-write socket on the
   picture and refuses the read-write tokens minted before it, so a socket that drove before cannot go on driving
   whatever its client does. The daemon cannot see the keys a media socket carries, so while the view drives, the agent
   is held out until the view hands back or closes, not until it has been idle. */

// A fresh token goes out this long before the last lapses.
const REFRESH_BEFORE_MS = 15_000;

export interface DesktopMedia {
    // Says again who may drive: a token read-only unless `driving`, and the agent held out while it is.
    readonly hand: (driving: boolean) => void;
    // A fresh `media` now: the viewer must dial again and its token lapsed.
    readonly resend: () => void;
    // The window moved: castd's crop follows it.
    readonly moveTo: (region: Region) => Promise<void>;
    readonly stop: () => void;
}

// One castd per picture: the whole desktop, or one window by its id. A window's castd ends with the last view of it.
const keyOf = (displayKey: string, only: string | undefined): string => (only === undefined ? displayKey : `${displayKey}-window-${only}`);
const viewers = new Map<string, number>();

// The media path for the desktop's picture, or undefined without castd (or one that will not answer), which leaves the
// view on its video.
const startDesktopMedia = async (
    displayKey: string,
    display: Display,
    only: string | undefined,
    region: Region,
    send: (text: string) => void,
): Promise<DesktopMedia | undefined> => {
    if (!castdAvailable()) {
        return undefined;
    }
    const key = keyOf(displayKey, only);
    const castd: Castd | undefined = ensureCastd({
        key,
        display: display.name,
        framing: { kind: "crop", rect: { x: region.x, y: region.y, width: region.width, height: region.height } },
    });
    if (castd === undefined || !(await castd.ready())) {
        return undefined;
    }
    viewers.set(key, (viewers.get(key) ?? 0) + 1);
    const path = `${BROWSER_MEDIA_PATH}/${castd.session}`;
    const secret = castdMediaKey();
    let driving = false;
    let stopped = false;
    let holding: ReturnType<typeof setInterval> | undefined;
    const sendMedia = (): void => {
        if (!stopped) {
            send(JSON.stringify(mediaMessage({ path, castd }, secret, !driving)));
        }
    };
    sendMedia();
    const refresh = setInterval(sendMedia, TOKEN_TTL_MS - REFRESH_BEFORE_MS);
    const unlisten = castd.onStarted(sendMedia);
    return {
        hand: (next) => {
            if (next === driving) {
                return;
            }
            driving = next;
            clearInterval(holding);
            holding = driving ? setInterval(() => ownerDriving(), OWNER_IDLE_MS / 2) : undefined;
            // Whoever drove before is cut off first, then the view is handed its token, minted after the cut so castd
            // takes it.
            const reason = driving ? "another view took control of the desktop" : "control of the desktop was handed back";
            void castd.control.dropViewers({ readWrite: true, reason }).then(sendMedia);
        },
        resend: sendMedia,
        moveTo: (moved) => castd.moveCrop({ x: moved.x, y: moved.y, width: moved.width, height: moved.height }),
        stop: () => {
            if (stopped) {
                return;
            }
            stopped = true;
            clearInterval(refresh);
            clearInterval(holding);
            unlisten();
            const left = (viewers.get(key) ?? 1) - 1;
            if (left > 0) {
                viewers.set(key, left);
                return;
            }
            viewers.delete(key);
            // The whole desktop's castd lives with the desktop's display (cast-window.ts ends it); a window's goes now.
            if (only !== undefined) {
                stopCastd(key);
            }
        },
    };
};

// What a desktop view's picture and hands are: castd's media path when the viewer asked for it and castd answers (no
// video and no XTEST then), else video and XTEST here as before. `first` is where the picture starts (the whole screen,
// or the window where it is); `closed` says the view went away meanwhile, which ends what was opened for it.
export interface DesktopPicture {
    readonly media: DesktopMedia | undefined;
    readonly input: XInput | undefined;
}

export const desktopPicture = async (
    display: Display,
    only: string | undefined,
    asked: boolean,
    first: () => Promise<Region | undefined>,
    send: (text: string) => void,
    closed: () => boolean,
): Promise<DesktopPicture> => {
    const region = asked ? await first() : undefined;
    const media = region === undefined ? undefined : await startDesktopMedia(DESKTOP_KEY, display, only, region, send);
    if (closed()) {
        media?.stop();
        return { media: undefined, input: undefined };
    }
    return media === undefined ? { media, input: startXInput(display) } : { media, input: undefined };
};

// The desktop's own settle timing (desktop-automation's DESKTOP_SETTLE): at most 1.5 s for an app to react, and 80 ms
// still to count as done.
const SETTLE_MAX_MS = 1_500;
const SETTLE_QUIET_MS = 80;

/**
 * Waits for the screen to show what an action did, on castd's pixels where the desktop has a castd (a view on the media
 * path): changed, then still, within the desktop's cap. False when it has none, for the screenshot-digest wait instead.
 */
export const castdSettled = async (key: string, now: () => number = Date.now): Promise<boolean> => {
    const control = castdOf(key)?.control;
    const started = now();
    const first = await control?.wait({ change: true, timeoutMs: SETTLE_MAX_MS });
    if (control === undefined || first === undefined) {
        return false;
    }
    if (first.changed) {
        await control.wait({ quietMs: SETTLE_QUIET_MS, timeoutMs: Math.max(0, SETTLE_MAX_MS - (now() - started)) });
    }
    return true;
};
