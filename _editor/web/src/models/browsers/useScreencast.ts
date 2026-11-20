import { parseJsonWith } from "@intentic/base/json";
import { computed, onScopeDispose, ref, type Ref, watch } from "vue";
import { z } from "zod";
import { boxAsker } from "./boxAsker";
import { FRAME_WEBP, type FrameUrls, frameUrls, videoTag } from "./frameUrls";
import type { MediaPicture } from "./media/mediaPicture";
import { screencastMedia } from "./media/screencastMedia";
import { canDecodeVideo, type VideoSink, videoSink } from "./videoSink";
import { liveSocket, type LiveSocket, type LiveSocketOptions, useLiveSocket, webSocketChannel } from "../../client/session/liveSocket";
import { onScreen } from "../../workbench/window/onScreen";

// THE PART OF A LIVE PICTURE EVERY SCREENCAST SHARES: the agent's browser (useBrowserView), the sandbox's desktop
// (useDesktopView) and a connected account's sign-in window (BrowserProfileDialog) each hold a live socket to a daemon
// route that sends a `ready` and then tagged pictures, and takes pointer moves, a size and pause/resume back. What each
// one says about it (its words, its status, its own messages) stays with it; how the picture is read, paused, sized
// and pointed at is decided once, here, so a safeguard one of them has is had by all three. Where castd serves the
// window, its socket names a media socket instead of sending pictures, and the picture, sound and input move there
// (media/screencastMedia.ts); the window's own socket keeps everything else.

// Roughly one display frame, the rate the far side can act on anyway: only enough to keep a 1000 Hz mouse from
// flooding the socket; each move is a few dozen bytes of JSON, and a press carries its own position.
export const MOVE_THROTTLE_MS = 16;
export { RESIZE_DEBOUNCE_MS } from "./boxAsker";

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

// What the screencast itself says on the socket, beside each route's own vocabulary. `keyframe`: the decoder lost the
// stream, and a fresh one is asked for.
export type ScreencastControl =
    | { readonly type: `pause` | `resume` | `keyframe` | `media` }
    | { readonly type: `resize`; readonly width: number; readonly height: number };

interface Size {
    readonly width: number;
    readonly height: number;
}

// The video frame as painted on the canvas, for a pane that places it and fills around it.
export interface PaintedPicture {
    // Its size in its own pixels; it trails `width`/`height` by the moment a new stream's first frame takes to decode.
    // Undefined until one paints, and on the frames path.
    readonly painted: Readonly<Ref<Size | undefined>>;
    // The page's background as its edges show it (videoSink's edgeColour); undefined when it has none.
    readonly edgeColour: () => string | undefined;
}

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
    // Whether this route may hand the picture to castd's media socket (`media=1`); without it the picture is its own.
    readonly media?: boolean;
    // The media socket dropped; the window's own socket may still be up.
    readonly onMediaDrop?: () => void;
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
    // The media path, on a route that may take it; its picture is up while `kind` is `media`.
    readonly media: MediaPicture | undefined;
    // Which picture this is; undefined until `ready`, or castd's `hello`.
    readonly kind: Ref<`video` | `frames` | `media` | undefined>;
    // The picture's size in its own pixels, off `ready`; pointer coordinates are mapped onto it.
    readonly width: Ref<number>;
    readonly height: Ref<number>;
    // Display pixels per CSS pixel of the picture.
    readonly scale: Ref<number>;
    // The current frames-path picture as an object URL; undefined on video.
    readonly frame: Ref<string | undefined>;
    readonly picture: PaintedPicture;
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

// One binary message on the window's own socket; the first byte is the daemon's own tag (screencast.ts/videocast.ts
// share the table). Read per picture rather than behind a mode flag, which could go stale across a reconnect onto a
// browser whose display just appeared. Answers the frames path's object URL, if the message was one.
const legacyPicture = (video: VideoSink, pictures: FrameUrls | undefined, isVideo: () => boolean, painted: () => void) => (data: ArrayBuffer): string | undefined => {
    const bytes = new Uint8Array(data);
    const tag = bytes[0];
    const coded = videoTag(tag);
    if (coded !== undefined) {
        video.push(bytes.subarray(1), coded.key, coded.quiet);
        painted();
        return undefined;
    }
    if (tag === FRAME_WEBP && isVideo()) {
        // The settled page, sharp; laid over the video until it moves.
        video.still(bytes.subarray(1));
        return undefined;
    }
    return pictures?.from(data);
};

// Roughly one display frame between pointer moves sent; a press always goes.
const moveThrottle = () => {
    let lastMove = 0;
    return (action: string): boolean => {
        if (action !== `move`) {
            return true;
        }
        const now = Date.now();
        if (now - lastMove < MOVE_THROTTLE_MS) {
            return false;
        }
        lastMove = now;
        return true;
    };
};

export const useScreencast = <Action extends string, Pointer extends object, Out extends object = object>(
    options: ScreencastOptions<Action, Pointer, Out>,
): Screencast<Action, Pointer, Out> => {
    const kind = ref<`video` | `frames` | `media` | undefined>();
    const width = ref(1280);
    const height = ref(800);
    const scale = ref(1);
    const frame = ref<string | undefined>();
    const painted = ref<Size | undefined>();
    // Turns each frames-path picture into an object URL, releasing ones the img has moved on from.
    const pictures = options.frames === true ? frameUrls() : undefined;
    const throttle = moveThrottle();

    // The socket below; declared ahead so every verb can say something on it.
    const say = (message: ScreencastControl): void => live.send(message);
    const sizes = boxAsker(
        (box) => say({ type: `resize`, width: box.width, height: box.height }),
        () => (kind.value === `video` || kind.value === `media`) && options.holdSize?.() !== true,
    );
    const video = videoSink(options.onVideoError, {
        onLost: () => say({ type: `keyframe` }),
        onSize: (paintedWidth, paintedHeight) => {
            painted.value = { width: paintedWidth, height: paintedHeight };
        },
    });
    // castd's hello is this path's `ready`: the picture's geometry, and the caller's word that a picture is coming.
    const media =
        options.media === true
            ? screencastMedia({
                  askFresh: () => say({ type: `media` }),
                  redial: () => live.connect(),
                  onHello: (hello) => {
                      [kind.value, width.value, height.value, scale.value] = [`media`, hello.width, hello.height, hello.scale];
                      options.onReady?.({ type: `ready`, kind: `video`, width: hello.width, height: hello.height, scale: hello.scale, codec: hello.codec });
                  },
                  onPicture: () => options.onPicture?.(),
                  onDrop: () => options.onMediaDrop?.(),
              })
            : undefined;

    // Sent before any picture, and again for every fresh stream (a resize, another window): which decoder to build and
    // what a click's coordinates mean. The codec is read out of the stream by the daemon rather than assumed.
    const onReady = (message: ScreencastMessage): void => {
        media?.ready();
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
        sizes.ask();
    };

    const takeText = (raw: string): void => {
        const message = readMessage(raw);
        if (message === undefined || media?.take(message) === true) {
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

    const legacy = legacyPicture(video, pictures, () => kind.value === `video`, () => options.onPicture?.());
    const takePicture = (data: ArrayBuffer): void => {
        const picture = options.detached?.() === true ? undefined : legacy(data);
        if (picture !== undefined) {
            frame.value = picture;
            options.onPicture?.();
        }
    };

    const socketOptions: LiveSocketOptions<string, Out | ScreencastControl> = {
        ...options.socket,
        mint: async () => (media === undefined ? options.mint() : media.address(await options.mint())),
        open: webSocketChannel({ text: takeText, binary: takePicture }),
        onOpen: () => {
            // A fresh socket knows nothing of the box; the first `ready` asks again.
            sizes.forget();
            options.socket?.onOpen?.();
        },
    };
    const live = options.outlivesScope === true ? liveSocket(socketOptions) : useLiveSocket(socketOptions);

    // A picture nobody can see would keep pulling every frame down the tunnel to nothing. The daemon holds its binding
    // across a pause, so resuming is one frame away, not a reconnect. onScreen rather than document.hidden: a Windows
    // webview hidden in the tray still reports itself visible.
    const syncVisibility = (): void => {
        const seen = onScreen.value && options.visible?.value !== false;
        say({ type: seen ? `resume` : `pause` });
        media?.picture.setVisible(seen);
    };
    watch(onScreen, syncVisibility);
    if (options.visible !== undefined) {
        watch(options.visible, syncVisibility);
    }

    onScopeDispose(() => {
        sizes.dispose();
        // An unreleased object URL holds its blob for the life of the document; a decoder holds buffers of its own.
        pictures?.release();
        video.close();
        media?.dispose();
    });

    return {
        live,
        video,
        media: media?.picture,
        kind,
        width,
        height,
        scale,
        frame,
        picture: {
            painted: computed(() => (kind.value === `media` ? media?.picture.painted.value : painted.value)),
            edgeColour: () => (kind.value === `media` ? media?.picture.edgeColour() : video.edgeColour()),
        },
        pointerAt: (action, event, picture) => (throttle(action) ? options.pointer(action, event, picture, width.value, height.value) : undefined),
        requestSize: (boxWidth, boxHeight) => {
            sizes.measured(boxWidth, boxHeight);
            media?.picture.requestSize(boxWidth, boxHeight);
            if (kind.value === `media`) {
                media?.picture.sampleEdge();
            }
        },
        askSizeAgain: () => {
            sizes.forget();
            sizes.ask();
        },
        syncVisibility,
        reset: () => {
            sizes.dispose();
            sizes.forget();
            frame.value = undefined;
            painted.value = undefined;
            // A decoder holds state for the stream it was built for; the next `ready` builds a new one.
            video.close();
            media?.reset();
            kind.value = undefined;
        },
    };
};
