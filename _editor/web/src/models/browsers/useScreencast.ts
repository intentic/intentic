import { parseJsonWith } from "@intentic/base/json";
import { onScopeDispose, ref, type Ref, watch } from "vue";
import { z } from "zod";
import { FRAME_WEBP, frameUrls, videoTag } from "./frameUrls";
import { canDecodeVideo, type VideoSink, videoSink } from "./videoSink";
import { liveSocket, type LiveSocket, type LiveSocketOptions, useLiveSocket, webSocketChannel } from "../../client/session/liveSocket";
import { onScreen } from "../../workbench/window/onScreen";

// THE PART OF A LIVE PICTURE EVERY SCREENCAST SHARES: the agent's browser (useBrowserView), the sandbox's desktop
// (useDesktopView) and a connected account's sign-in window (BrowserProfileDialog) each hold a live socket to a daemon
// route that sends a `ready` and then tagged pictures, and takes pointer moves, a size and pause/resume back. What each
// one says about it (its words, its status, its own messages) stays with it; how the picture is read, paused, sized
// and pointed at is decided once, here, so a safeguard one of them has is had by all three.

// Roughly one display frame, the rate the far side can act on anyway: only enough to keep a 1000 Hz mouse from
// flooding the socket; each move is a few dozen bytes of JSON, and a press carries its own position.
export const MOVE_THROTTLE_MS = 16;
// A size is asked once the box has held still this long: every step of a drag would otherwise restart the encoder.
export const RESIZE_DEBOUNCE_MS = 250;

// A field the daemon sends, read loosely: one of a type this build does not expect is absent, not a refused message.
const maybe = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

/**
 * Anything the daemon says besides a picture: a `type`, the fields the screencast routes share, and whatever else that
 * type carries, kept for its own reader to parse.
 */
const ScreencastMessageSchema = z.looseObject({
    type: z.string(),
    kind: maybe(z.string()),
    width: maybe(z.number()),
    height: maybe(z.number()),
    scale: maybe(z.number()),
    codec: maybe(z.string()),
    message: maybe(z.string()),
    text: maybe(z.string()),
    cursor: maybe(z.string()),
    owner: maybe(z.boolean()),
});
export type ScreencastMessage = z.infer<typeof ScreencastMessageSchema>;

// A text frame that is not one of the daemon's messages says nothing this view understands; the next one is read as
// usual.
const readMessage = (raw: string): ScreencastMessage | undefined => {
    return parseJsonWith(raw, ScreencastMessageSchema);
};

// What the screencast itself says on the socket, beside each route's own vocabulary.
export type ScreencastControl = { readonly type: `pause` | `resume` } | { readonly type: `resize`; readonly width: number; readonly height: number };

interface Size {
    readonly width: number;
    readonly height: number;
}

const sameSize = (left: Size | undefined, right: Size | undefined): boolean =>
    left !== undefined && right !== undefined && left.width === right.width && left.height === right.height;

export interface ScreencastOptions<Action extends string, Pointer, Out> {
    // The route's authenticated address, or undefined while there is nowhere to dial (liveSocket's `mint`).
    readonly mint: () => Promise<string | undefined>;
    // Builds the route's pointer message for an action at an event over the picture, against the picture's own size;
    // undefined while the picture has no box to aim at.
    readonly pointer: (action: Action, event: MouseEvent, picture: HTMLElement, width: number, height: number) => Pointer | undefined;
    // Every message but a picture, `ready` and `pong`, which are read here.
    readonly onMessage?: (message: ScreencastMessage) => void;
    // After `ready` has set the geometry and the decoder: the caller's own word that a picture is on its way.
    readonly onReady?: (message: ScreencastMessage) => void;
    // A `ready` for video in a browser with no VideoDecoder: no picture will ever paint, which is said rather than
    // shown as an empty box.
    readonly onUnsupported: () => void;
    // The decoder's own failure, in its words.
    readonly onVideoError: (message: string) => void;
    // A picture painted (a video frame, or a frames-path image).
    readonly onPicture?: () => void;
    // Whether this route may answer with CDP's page-only frames instead of video (`ready`'s `kind`); without it every
    // picture is video.
    readonly frames?: boolean;
    // Whether anyone can see the picture besides the window being on screen (its tab in front, its view not parked).
    readonly visible?: Ref<boolean>;
    // The picture's owner is gone while its socket stays up for something else (a dialog closed during a save):
    // pictures and `ready` are dropped, and every other message still reaches `onMessage`.
    readonly detached?: () => boolean;
    // A size the caller is not to ask for now (a phone the page is framed as decides the picture's size instead).
    readonly holdSize?: () => boolean;
    // A socket that must outlive the scope that made it (a save it is waiting on): disposed by the caller, not the scope.
    readonly outlivesScope?: boolean;
    readonly socket?: Pick<LiveSocketOptions<string, Out | ScreencastControl>, `onMintFailed` | `onUnreachable` | `onOpen` | `onDrop` | `staleCheck`>;
}

export interface Screencast<Action extends string, Pointer, Out> {
    readonly live: LiveSocket<Out | ScreencastControl>;
    readonly video: VideoSink;
    // Which picture this is; undefined until `ready`.
    readonly kind: Ref<`video` | `frames` | undefined>;
    // The picture's size in its own pixels, off `ready`; pointer coordinates are mapped onto it.
    readonly width: Ref<number>;
    readonly height: Ref<number>;
    // Display pixels per CSS pixel of the picture.
    readonly scale: Ref<number>;
    // The current frames-path picture as an object URL; undefined on video.
    readonly frame: Ref<string | undefined>;
    // The pointer message for this action, or undefined when a move comes inside the throttle or there is no box.
    readonly pointerAt: (action: Action, event: MouseEvent, picture: HTMLElement) => Pointer | undefined;
    // Asks the daemon to size the picture to this box once it holds still; a box it already has is not asked again.
    readonly requestSize: (width: number, height: number) => void;
    // Asks for the box again even if it was asked already, as a fresh socket would (a phone frame let go of).
    readonly askSizeAgain: () => void;
    // Tells the daemon whether anyone can see the picture; said on every change, and by the caller on every open.
    readonly syncVisibility: () => void;
    // Forgets the picture: what a switch to another browser or desktop starts from.
    readonly reset: () => void;
}

export const useScreencast = <Action extends string, Pointer extends object, Out extends object = object>(
    options: ScreencastOptions<Action, Pointer, Out>,
): Screencast<Action, Pointer, Out> => {
    const kind = ref<`video` | `frames` | undefined>();
    const width = ref(1280);
    const height = ref(800);
    const scale = ref(1);
    const frame = ref<string | undefined>();
    const video = videoSink(options.onVideoError);
    // Turns each frames-path picture into an object URL, releasing ones the img has moved on from.
    const pictures = options.frames === true ? frameUrls() : undefined;
    let lastMove = 0;
    // The box's last measured size, and the last one asked on this socket.
    let boxSize: Size | undefined;
    let askedSize: Size | undefined;
    let resizeTimer: number | undefined;

    // The socket below; declared ahead so every verb can say something on it.
    const say = (message: ScreencastControl): void => live.send(message);

    const askSize = (): void => {
        if (kind.value !== `video` || options.holdSize?.() === true || boxSize === undefined || sameSize(boxSize, askedSize)) {
            return;
        }
        askedSize = boxSize;
        say({ type: `resize`, ...boxSize });
    };

    // Sent before any picture, and again for every fresh stream (a resize, another window): which decoder to build and
    // what a click's coordinates mean. The codec is read out of the stream by the daemon rather than assumed.
    const onReady = (message: ScreencastMessage): void => {
        kind.value = options.frames === true && message.kind !== `video` ? `frames` : `video`;
        width.value = message.width ?? width.value;
        height.value = message.height ?? height.value;
        scale.value = message.scale !== undefined && message.scale > 0 ? message.scale : 1;
        if (kind.value === `video`) {
            if (!canDecodeVideo()) {
                options.onUnsupported();
                return;
            }
            video.configure(message.codec ?? ``);
        }
        options.onReady?.(message);
        askSize();
    };

    const takeText = (raw: string): void => {
        const message = readMessage(raw);
        if (message === undefined) {
            return;
        }
        if (message.type === `pong`) {
            live.ponged();
        } else if (message.type === `ready`) {
            if (options.detached?.() !== true) {
                onReady(message);
            }
        } else {
            options.onMessage?.(message);
        }
    };

    // One binary message; the first byte is the daemon's own tag (screencast.ts/videocast.ts share the table). Read
    // per picture rather than behind a mode flag, which could go stale across a reconnect onto a browser whose display
    // just appeared.
    const takePicture = (data: ArrayBuffer): void => {
        if (options.detached?.() === true) {
            return;
        }
        const bytes = new Uint8Array(data);
        const tag = bytes[0];
        const coded = videoTag(tag);
        if (coded !== undefined) {
            video.push(bytes.subarray(1), coded.key, coded.quiet);
            options.onPicture?.();
            return;
        }
        if (tag === FRAME_WEBP && kind.value === `video`) {
            // The settled page, sharp; laid over the video until it moves.
            video.still(bytes.subarray(1));
            return;
        }
        const picture = pictures?.from(data);
        if (picture !== undefined) {
            frame.value = picture;
            options.onPicture?.();
        }
    };

    const socketOptions: LiveSocketOptions<string, Out | ScreencastControl> = {
        ...options.socket,
        mint: options.mint,
        open: webSocketChannel({ text: takeText, binary: takePicture }),
        onOpen: () => {
            // A fresh socket knows nothing of the box; the first `ready` asks again.
            askedSize = undefined;
            options.socket?.onOpen?.();
        },
    };
    const live = options.outlivesScope === true ? liveSocket(socketOptions) : useLiveSocket(socketOptions);

    // A picture nobody can see would keep pulling every frame down the tunnel to nothing. The daemon holds its binding
    // across a pause, so resuming is one frame away, not a reconnect. onScreen rather than document.hidden: a Windows
    // webview hidden in the tray still reports itself visible.
    const syncVisibility = (): void => say({ type: onScreen.value && options.visible?.value !== false ? `resume` : `pause` });
    watch(onScreen, syncVisibility);
    if (options.visible !== undefined) {
        watch(options.visible, syncVisibility);
    }

    onScopeDispose(() => {
        window.clearTimeout(resizeTimer);
        // An unreleased object URL holds its blob for the life of the document; a decoder holds buffers of its own.
        pictures?.release();
        video.close();
    });

    return {
        live,
        video,
        kind,
        width,
        height,
        scale,
        frame,
        pointerAt: (action, event, picture) => {
            if (action === `move`) {
                const now = Date.now();
                if (now - lastMove < MOVE_THROTTLE_MS) {
                    return undefined;
                }
                lastMove = now;
            }
            return options.pointer(action, event, picture, width.value, height.value);
        },
        requestSize: (boxWidth, boxHeight) => {
            const size = { width: Math.round(boxWidth), height: Math.round(boxHeight) };
            if (size.width <= 0 || size.height <= 0 || sameSize(size, boxSize)) {
                return;
            }
            boxSize = size;
            window.clearTimeout(resizeTimer);
            resizeTimer = window.setTimeout(askSize, RESIZE_DEBOUNCE_MS);
        },
        askSizeAgain: () => {
            askedSize = undefined;
            askSize();
        },
        syncVisibility,
        reset: () => {
            window.clearTimeout(resizeTimer);
            askedSize = undefined;
            frame.value = undefined;
            // A decoder holds state for the stream it was built for; the next `ready` builds a new one.
            video.close();
            kind.value = undefined;
        },
    };
};
