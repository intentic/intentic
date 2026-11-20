import { webTransportDeclared } from "../../../client/transport/declared";
import { useEndpoint } from "../../../client/endpoint/useEndpoint";
import { type MediaHello, MediaOfferSchema } from "./mediaMessages";
import { mediaPicture, type MediaPicture, type MediaPictureOptions } from "./mediaPicture";

// THE MEDIA PATH AS A SCREENCAST SEES IT (useScreencast.ts). A window's own socket opened with `media=1` answers, where
// castd serves the window, with `media` and no pictures; one from before castd, or a window castd does not serve,
// ignores the query and sends `ready` and pictures as it always has, which is the fallback with nothing to decide. The
// one thing to guard is a media socket that never comes up (a netd that cannot route it, a castd that refuses this
// browser): with no `hello` within GIVE_UP_MS of the offer, the window's socket is dialled again without `media=1`, and
// stays on its own pictures until the view moves to another window. A decoder that cannot read castd's stream falls
// back the same way, where the window's own path says what this browser cannot play.

export const GIVE_UP_MS = 15_000;

export interface ScreencastMediaOptions {
    // Asks the window's own socket for a fresh token (`{type: "media"}`).
    readonly askFresh: () => void;
    // Dials the window's own socket again: it will now be asked without `media=1`.
    readonly redial: () => void;
    readonly onHello: (hello: MediaHello) => void;
    readonly onPicture: () => void;
    readonly onDrop: () => void;
    // Seams for a test.
    readonly picture?: (options: MediaPictureOptions) => MediaPicture;
    readonly later?: (run: () => void, ms: number) => () => void;
}

export interface ScreencastMedia {
    readonly picture: MediaPicture;
    // The window socket's address, with `media=1` unless this window fell back.
    readonly address: (url: string | undefined) => string | undefined;
    // A message on the window's socket: true when it was the media path's (`media`).
    readonly take: (message: { readonly type: string }) => boolean;
    // The window's socket sent `ready`: its own pictures are back, and the media socket goes.
    readonly ready: () => void;
    // Another window, or none: the media path is tried afresh.
    readonly reset: () => void;
    readonly dispose: () => void;
}

const withMedia = (url: string): string => `${url}${url.includes(`?`) ? `&` : `?`}media=1`;

// The sandbox's base as the window's socket was dialled on it, everything before its `/system/` route: the media
// socket opens on the same sandbox, by the same way in, as the socket that named it.
const baseOf = (url: string): string | undefined => {
    const at = url.indexOf(`/system/`);
    return at < 0 ? undefined : url.slice(0, at);
};

const timeout = (run: () => void, ms: number): (() => void) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
};

export const screencastMedia = (options: ScreencastMediaOptions): ScreencastMedia => {
    const later = options.later ?? timeout;
    let fellBack = false;
    // A window socket can outlive its view (a save it waits on): the fresh tokens it is sent then are nobody's.
    let disposed = false;
    let base: string | undefined;
    let giveUp: (() => void) | undefined;
    const settle = (): void => {
        giveUp?.();
        giveUp = undefined;
    };
    const fallBack = (): void => {
        settle();
        fellBack = true;
        picture.stop();
        options.redial();
    };
    const picture = (options.picture ?? mediaPicture)({
        base: () => base,
        askFresh: options.askFresh,
        onHello: (hello) => {
            settle();
            options.onHello(hello);
        },
        onPicture: options.onPicture,
        onDrop: options.onDrop,
        // The media socket rides the edge's WebTransport where terminals would, and a peer straight to castd is tried
        // wherever the socket is not already on the loopback shortcut, which is as short as a way gets.
        webTransport: webTransportDeclared,
        peerWanted: () => !useEndpoint().usingLocal.value,
        onFailed: fallBack,
    });
    return {
        picture,
        address: (url) => {
            base = url === undefined ? base : baseOf(url);
            return url === undefined || fellBack ? url : withMedia(url);
        },
        take: (message) => {
            if (message.type !== `media`) {
                return false;
            }
            const offer = MediaOfferSchema.safeParse(message);
            if (offer.success && !fellBack && !disposed) {
                if (picture.hello.value === undefined && giveUp === undefined) {
                    giveUp = later(fallBack, GIVE_UP_MS);
                }
                picture.offer(offer.data);
            }
            return true;
        },
        ready: () => {
            settle();
            picture.stop();
        },
        reset: () => {
            settle();
            fellBack = false;
            picture.stop();
        },
        dispose: () => {
            disposed = true;
            settle();
            picture.dispose();
        },
    };
};
