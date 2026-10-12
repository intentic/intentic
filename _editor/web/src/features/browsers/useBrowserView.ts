import { errorMessage } from "@intentic/base/errors";
import { t } from "@intentic/ui/i18n";
import { onScopeDispose, ref, type Ref, watch } from "vue";
import { z } from "zod";
import { keyIntent, type BrowserCommand, type KeyFrame } from "./keyIntent";
import { pointerFrame, type PointerAction } from "./pointerFrame";
import { selectionCopy } from "./selectionCopy";
import { type ScreencastMessage, useScreencast } from "./useScreencast";
import { socketUrl as wsSocketUrl } from "../sandbox/session/wsTicket";

// One live view of the agent's browser over /system/browser-view, with clicks/keys going back. `ready` picks video
// (H.264 of the page's viewport off the browser's own X display into a canvas, with a sharp still laid over it once
// the page settles) or frames (CDP's page-only compositor surface into an img); kind and geometry always come off the
// wire. The chrome around the picture is the pane's own, steered by the verbs below. No scrollback to preserve like
// a terminal, so this is plain reactive state, and nothing is sent to the page until the user takes control.

// Mirrors the daemon's SelectMenu (screencast.ts); the browser package can't import that contract, so it's
// re-declared here, and read as the daemon's word rather than trusted.
const SelectMenuSchema = z.object({
    options: z.array(z.object({ label: z.string(), disabled: z.boolean() })).readonly(),
    selected: z.number(),
    rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
});
export type SelectMenu = z.infer<typeof SelectMenuSchema>;

export interface BrowserView {
    // Which picture this is, so the pane mounts canvases or an img; undefined until `ready`.
    readonly kind: Ref<"video" | "frames" | undefined>;
    // Remote geometry pointer coordinates map onto (the page's viewport, in the display's pixels on video); off the
    // wire, never assumed.
    readonly viewWidth: Ref<number>;
    readonly viewHeight: Ref<number>;
    // Display pixels per CSS pixel of the picture: shown at width/scale CSS px, the page is 1:1.
    readonly viewScale: Ref<number>;
    // Where the video and its still paint; the pane hands its canvases over on mount, nothing else uses them. Null is
    // the pane's canvases going away, which is how a template ref reads once unmounted.
    readonly attachCanvases: (video: HTMLCanvasElement | null, still: HTMLCanvasElement | null) => void;
    // The current frame as an object URL, frames path only; undefined until the first lands, always undefined on video.
    readonly frame: Ref<string | undefined>;
    // What to say while there's no picture: connecting, reconnecting, or why there never will be one.
    readonly status: Ref<string | undefined>;
    // True while the user's input is being forwarded; off by default.
    readonly driving: Ref<boolean>;
    // CSS cursor keyword from the daemon: the picture carries no pointer, the pane draws the local one in this shape.
    readonly cursor: Ref<string>;
    // Stream a specific page instead of following the agent; brings it in front.
    readonly bindPage: (pageId: string) => void;
    // A native <select> renders outside the page, so no frame shows it; the daemon reports options instead.
    readonly select: Ref<SelectMenu | undefined>;
    readonly chooseOption: (index: number) => void;
    readonly closeSelect: () => void;
    // No-op unless `driving`, so taking control is a state flip, not a listener rebuild; no window where a
    // half-attached pane double-handles events.
    readonly onMouseMove: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onMouseDown: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onMouseUp: (event: MouseEvent, frame: HTMLElement) => void;
    readonly onWheel: (event: WheelEvent, frame: HTMLElement) => void;
    // The chrome's own verbs (keyIntent's `command`) go to `onCommand`, which the pane answers with its tabs and
    // address bar; the page's keys go to the browser.
    readonly onKeyDown: (event: KeyboardEvent, onCommand?: (command: BrowserCommand) => void) => void;
    // Left to the host: the remote clipboard is the sandbox's own, and the host's paste event carries the real one.
    readonly onPaste: (event: ClipboardEvent) => void;
    // The tab the picture shows, or the one `pageId` names: a tab the picture may not be on yet (one just opened).
    readonly navigate: (url: string, pageId?: string) => void;
    readonly back: () => void;
    readonly forward: () => void;
    readonly reload: () => void;
    readonly stop: () => void;
    readonly newTab: (url?: string) => void;
    readonly closeTab: (pageId: string) => void;
    // Chromium's own find bar: opened on the display, and fed every keystroke there until Escape or a click.
    readonly find: () => void;
    // The picture box's size in CSS px; the daemon sizes the browser window so the viewport is exactly that.
    readonly requestSize: (width: number, height: number) => void;
    // Renders the page as a phone would (its CSS viewport, a touch screen, its user agent), or as itself again with
    // none. While a device is set, the device decides the picture's size and `requestSize` waits.
    readonly emulate: (device: EmulatedDevice | undefined) => void;
    // Answers the dialog the session lists; `text` is a prompt's reply.
    readonly answerDialog: (accept: boolean, text?: string) => void;
}

// What `emulate` asks the daemon to render as: a phone's CSS viewport in portrait, as a touch screen, under its UA.
export interface EmulatedDevice {
    readonly width: number;
    readonly height: number;
    readonly mobile: boolean;
    readonly userAgent?: string | undefined;
}

export interface BrowserViewOptions {
    // Whether anyone can see the picture (its tab in front, its view not parked): the daemon stops sending frames while
    // not, as it does for a hidden document, and resumes one frame away.
    readonly visible?: Ref<boolean>;
}

// Authenticated wss URL, or undefined if unreachable/not signed in; base and token are read together after the
// token await, from one active-sandbox snapshot.
const socketUrl = (name: string): Promise<string | undefined> => wsSocketUrl(`/system/browser-view`, { session: name });

// Follows `name` as the view switches browsers; a change tears the old socket down and opens a new one, with
// nothing to preserve across the switch.
export const useBrowserView = (name: Ref<string | undefined>, options: BrowserViewOptions = {}): BrowserView => {
    const status = ref<string | undefined>(t(`browsers.browserView.connecting`));
    const driving = ref(false);
    const cursor = ref(`default`);
    const select = ref<SelectMenu | undefined>();
    // The page the user picked, re-sent on every reconnect so a dropped socket doesn't silently switch them back to
    // the agent's tab.
    let pinned: string | undefined;
    // Keystrokes go to the display rather than the page while Chromium's find bar has them; see `find`.
    let rawKeys = false;
    // The device the page is rendered as, re-said on every reconnect like the pin; none is the page as itself.
    let device: EmulatedDevice | undefined;

    // The screencast below; declared ahead so every verb can say something on it.
    const send = (message: object): void => cast.live.send(message);
    const copy = selectionCopy(send);

    // The daemon knows this session is done for good; reconnecting would only ask the same dead question.
    const onError = (reason: string | undefined): void => {
        cast.live.end();
        status.value = reason ?? t(`browsers.browserView.sessionGone`);
        cast.frame.value = undefined;
    };

    // Everything on this socket besides a picture and `ready`, kept separate so each message type is one branch.
    const onMessage = (message: ScreencastMessage): void => {
        switch (message.type) {
            case `cursor`:
                // What the remote page shows under the pointer, sent only on change (see `cursor` in the interface).
                cursor.value = message.cursor ?? `default`;
                break;
            case `selection`:
                copy.answer(message.text);
                break;
            case `select`:
                // Sent after every release: a menu to draw, or null to close one the user clicked away from.
                select.value = SelectMenuSchema.nullable().catch(null).parse(message[`menu`]) ?? undefined;
                break;
            case `gone`:
                // The tab closed between relist and click; drop the pin so the stream follows the agent again.
                pinned = undefined;
                break;
            case `error`:
                onError(message.message);
                break;
            default:
                break;
        }
    };

    // `ready` picks the picture (video, or the frames path's img) and its geometry; the daemon pongs every ping, and a
    // still page sends no frames, so its silence clock is the plain one.
    const cast = useScreencast({
        mint: async () => {
            const session = name.value;
            return session === undefined ? undefined : socketUrl(session);
        },
        pointer: pointerFrame,
        frames: true,
        visible: options.visible,
        holdSize: () => device !== undefined,
        onMessage,
        onReady: () => {
            status.value = t(`browsers.browserView.waiting`);
        },
        onUnsupported: () => {
            status.value = t(`browsers.browserView.unsupported`);
        },
        onVideoError: (message) => {
            status.value = message;
        },
        onPicture: () => {
            status.value = undefined;
        },
        socket: {
            onMintFailed: (error) => {
                // A session that couldn't be minted (sandbox restarting, network down) retries like a drop; nothing else would.
                console.warn(`browser ${name.value ?? ``}: authorizing the view's socket failed`, error);
                status.value = t(`browsers.browserView.authFailed`, { reason: errorMessage(error) });
            },
            onUnreachable: () => {
                status.value = t(`browsers.browserView.unreachable`);
            },
            onOpen: () => {
                if (pinned !== undefined) {
                    send({ type: `bind`, pageId: pinned });
                }
                if (device !== undefined) {
                    send({ type: `emulate`, device });
                }
                // A newly (re)opened socket starts out streaming; the daemon can't know otherwise until told.
                cast.syncVisibility();
            },
            onDrop: () => {
                status.value = t(`browsers.browserView.reconnecting`);
            },
        },
    });
    const { video } = cast;

    const teardown = (): void => {
        copy.cancel();
        cast.live.close();
    };

    watch(
        name,
        () => {
            teardown();
            pinned = undefined;
            rawKeys = false;
            // Each window is its own; the next one starts as itself, and the caller says again if it should not.
            device = undefined;
            driving.value = false;
            // Nothing of the browser being left carries over: its picture, its decoder, the box asked of it.
            cast.reset();
            // A shape from the browser being left describes nothing in the next one, which isn't being driven yet
            // anyway.
            cursor.value = `default`;
            // A menu from the browser being left has nothing left to point at.
            select.value = undefined;
            status.value = name.value === undefined ? undefined : t(`browsers.browserView.connecting`);
            if (name.value !== undefined) {
                cast.live.connect();
            }
        },
        { immediate: true },
    );

    onScopeDispose(teardown);

    // Every pointer event routes through here, so `driving` is checked once and a frame built in one place
    // (pointerFrame); nothing reaches the page while only watching. Moves are throttled to one display frame.
    const sendPointer = (action: PointerAction, event: MouseEvent, element: HTMLElement): void => {
        if (!driving.value) {
            return;
        }
        // Undefined while the picture has no box (a frames <img> before its first src): sending would aim at the
        // remote origin instead of where the user pointed.
        const pointer = cast.pointerAt(action, event, element);
        if (pointer !== undefined) {
            send(pointer);
        }
    };

    // A page keystroke, on the display instead while the find bar has the keyboard.
    const sendKey = (chord: KeyFrame): void => {
        send(rawKeys ? { ...chord, raw: true } : chord);
        if (rawKeys && chord.key === `Escape`) {
            rawKeys = false;
        }
    };

    return {
        kind: cast.kind,
        viewWidth: cast.width,
        viewHeight: cast.height,
        viewScale: cast.scale,
        attachCanvases: video.attach,
        frame: cast.frame,
        status,
        driving,
        cursor,
        bindPage: (pageId) => {
            // Another tab: the still over the picture is of the one being left (the frames path's img is replaced by
            // the next frame anyway).
            if (pinned !== pageId) {
                video.dropStill();
            }
            pinned = pageId;
            send({ type: `bind`, pageId });
        },
        select,
        // Closed here, not on the daemon's word: the pick applies to what the owner is looking at, and waiting for
        // confirmation would read as a click that did nothing.
        chooseOption: (index) => {
            select.value = undefined;
            send({ type: `selectOption`, index });
        },
        closeSelect: () => (select.value = undefined),
        onMouseMove: (event, element) => sendPointer(`move`, event, element),
        onMouseDown: (event, element) => {
            // A click puts the keyboard back on the page, wherever the find bar left it.
            rawKeys = false;
            sendPointer(`down`, event, element);
        },
        onMouseUp: (event, element) => sendPointer(`up`, event, element),
        onWheel: (event, element) => {
            if (!driving.value) {
                return;
            }
            event.preventDefault();
            sendPointer(`wheel`, event, element);
        },
        // Which half of the keyboard a keystroke belongs to is keyIntent's call (paste stays with the host, select-all
        // doesn't, a browser verb is the pane's); nothing happens unless the user has taken the wheel.
        onKeyDown: (event, onCommand) => {
            if (!driving.value) {
                return;
            }
            const intent = keyIntent(event);
            if (intent.kind === `device`) {
                return;
            }
            event.preventDefault();
            if (intent.kind === `command`) {
                onCommand?.(intent.command);
            } else if (intent.kind === `text`) {
                send(rawKeys ? { type: `text`, text: intent.text, raw: true } : { type: `text`, text: intent.text });
            } else if (intent.kind === `key`) {
                sendKey(intent.frame);
            } else {
                void copy.copyOut(intent.frame, event.target instanceof Element ? event.target : undefined);
            }
        },
        onPaste: (event) => {
            const text = event.clipboardData?.getData(`text/plain`);
            if (!driving.value || text === undefined || text === ``) {
                return;
            }
            event.preventDefault();
            send({ type: `text`, text });
        },
        navigate: (url, pageId) => send(pageId === undefined ? { type: `navigate`, url } : { type: `navigate`, url, pageId }),
        back: () => send({ type: `back` }),
        forward: () => send({ type: `forward` }),
        reload: () => send({ type: `reload` }),
        stop: () => send({ type: `stop` }),
        newTab: (url) => send(url === undefined ? { type: `newTab` } : { type: `newTab`, url }),
        closeTab: (pageId) => send({ type: `closeTab`, pageId }),
        find: () => {
            send({ type: `key`, key: `f`, ctrl: true, raw: true });
            rawKeys = true;
        },
        requestSize: cast.requestSize,
        emulate: (next) => {
            const same =
                next === device ||
                (next !== undefined &&
                    device !== undefined &&
                    next.width === device.width &&
                    next.height === device.height &&
                    next.mobile === device.mobile &&
                    next.userAgent === device.userAgent);
            if (same) {
                return;
            }
            device = next;
            send(next === undefined ? { type: `emulate` } : { type: `emulate`, device: next });
            // Back to itself, the page is sized to the box again: the daemon has the box it had before, but asking is
            // what a fresh box is, so the last one asked is forgotten.
            if (next === undefined) {
                cast.askSizeAgain();
            }
        },
        answerDialog: (accept, text) => send(text === undefined ? { type: `dialog`, accept } : { type: `dialog`, accept, text }),
    };
};
