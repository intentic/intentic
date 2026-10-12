import { errorMessage } from "@intentic/base/errors";
import { onScopeDispose, ref, type Ref, watch } from "vue";
import { keyMessage, pointerMessage, wheelGauge, type DesktopKey, type DesktopMouse, type DesktopPointerAction, type DesktopText } from "./desktopInput";
import { type ScreencastMessage, useScreencast } from "../browsers/useScreencast";
import { socketUrl } from "../sandbox/session/wsTicket";

// The sandbox's own desktop over /system/desktop-view (the daemon's desktop/desktop-view.ts): H.264 of the whole
// display, or of one window on it, into a canvas, and, once the owner takes over, their pointer and keys back onto it.
// One desktop per sandbox, so the only thing followed is which sandbox is active; nothing reaches the desktop until the
// owner takes over.

// How long the hold outlives the owner's last input (agent-desktop.ts OWNER_IDLE_MS). The daemon announces a hold when
// it starts and never when it lapses, so the view lets it lapse by the same clock rather than show one that is gone.
export const HOLD_MS = 20_000;
// What the daemon closes with when the ticket is not enough to drive the desktop: a policy refusal, not a drop.
const CLOSE_REFUSED = 1008;

// What to say while there is no picture; the view words it. `detail` is the failure's own sentence.
export type DesktopStatus =
    | { readonly kind: `connecting` | `reconnecting` | `unreachable` | `waiting` | `unsupported` | `refused` | `gone` }
    | { readonly kind: `authFailed` | `failed`; readonly detail: string };

// Everything this view says to the daemon besides what every screencast says (useScreencast.ts).
type Outgoing = { readonly type: `control`; readonly driving: boolean } | DesktopMouse | DesktopKey | DesktopText;

export interface DesktopView {
    readonly status: Ref<DesktopStatus | undefined>;
    // The picture's size in its own pixels, off `ready`; pointer coordinates are mapped onto it.
    readonly width: Ref<number>;
    readonly height: Ref<number>;
    // True while this view forwards the owner's input.
    readonly driving: Ref<boolean>;
    // True while the owner holds the desktop and the agent's own desktop tools are refused.
    readonly held: Ref<boolean>;
    // Where the video paints; null is the canvas going away, as a template ref reads once unmounted.
    readonly attachCanvas: (canvas: HTMLCanvasElement | null) => void;
    readonly takeOver: () => void;
    readonly handBack: () => void;
    // No-ops unless driving, so taking over is a state flip rather than a listener rebuild.
    readonly onPointer: (action: DesktopPointerAction, event: MouseEvent, picture: HTMLElement) => void;
    readonly onWheel: (event: WheelEvent, picture: HTMLElement) => void;
    readonly onKeyDown: (event: KeyboardEvent) => void;
    readonly onPaste: (event: ClipboardEvent) => void;
}

// The hold as the daemon keeps it: set when it says so, renewed by each input, gone HOLD_MS after the last one.
interface HoldClock {
    readonly set: (owner: boolean) => void;
    readonly renew: () => void;
}
const holdClock = (held: Ref<boolean>): HoldClock => {
    let timer: number | undefined;
    const renew = (): void => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => (held.value = false), HOLD_MS);
    };
    return {
        set: (owner) => {
            held.value = owner;
            if (owner) {
                renew();
            } else {
                window.clearTimeout(timer);
            }
        },
        renew,
    };
};

export interface DesktopViewOptions {
    // One window on the desktop, by its id (DesktopWindow.id): the picture is that window alone, following it as it
    // moves, and the view ends with `gone` once it closes. Absent for the whole display.
    readonly window?: string | undefined;
    // Whether anyone can see the picture (its tab in front, its view not parked): the daemon stops grabbing the display
    // while not, as it does for a hidden document, and a hold taken here is handed back.
    readonly visible?: Ref<boolean>;
}

// Follows `sandbox` (any value that changes when the active sandbox does): a change tears the socket down and dials
// the new one's desktop. Undefined dials nothing.
export const useDesktopView = (sandbox: Ref<string | undefined>, options: DesktopViewOptions = {}): DesktopView => {
    const status = ref<DesktopStatus | undefined>({ kind: `connecting` });
    const driving = ref(false);
    const held = ref(false);
    const hold = holdClock(held);
    const wheel = wheelGauge();

    // The screencast below, declared ahead so every verb can say something on it.
    const send = (message: Outgoing): void => cast.live.send(message);

    // Each input renews the daemon's hold, so the local one is renewed with it; a lapsed one comes back as `held`.
    const sendInput = (message: DesktopMouse | DesktopKey | DesktopText): void => {
        if (!driving.value) {
            return;
        }
        send(message);
        if (held.value) {
            hold.renew();
        }
    };

    const onMessage = (message: ScreencastMessage): void => {
        if (message.type === `held`) {
            hold.set(message.owner === true);
        } else if (message.type === `gone`) {
            // The window this view was of has closed; there is nothing left to dial.
            cast.live.end();
            driving.value = false;
            status.value = { kind: `gone` };
        } else if (message.type === `error`) {
            // The desktop could not start; dialling again would only ask the same question.
            cast.live.end();
            status.value = { kind: `failed`, detail: message.message ?? `` };
        }
    };

    const windowId = options.window;
    // H.264 of the display, or of one window on it (3 keyframe, 4 delta; videocast.ts encodeVideo), measured in the
    // desktop's own pixels (agent-desktop.ts DESKTOP_SIZE until `ready` says otherwise).
    const cast = useScreencast<DesktopPointerAction, DesktopMouse, Outgoing>({
        mint: () => (windowId === undefined ? socketUrl(`/system/desktop-view`) : socketUrl(`/system/desktop-view`, { window: windowId })),
        pointer: pointerMessage,
        visible: options.visible,
        onMessage,
        onReady: () => {
            status.value = { kind: `waiting` };
        },
        onUnsupported: () => {
            status.value = { kind: `unsupported` };
        },
        onVideoError: () => {
            status.value = { kind: `unsupported` };
        },
        onPicture: () => {
            status.value = undefined;
        },
        socket: {
            onMintFailed: (error) => {
                status.value = { kind: `authFailed`, detail: errorMessage(error) };
            },
            onUnreachable: () => {
                status.value = { kind: `unreachable` };
            },
            onOpen: () => {
                cast.syncVisibility();
                // A drop handed the desktop back; an owner still driving takes it again rather than clicking into nothing.
                if (driving.value) {
                    send({ type: `control`, driving: true });
                }
            },
            onDrop: (code) => {
                hold.set(false);
                if (code === CLOSE_REFUSED) {
                    cast.live.end();
                    status.value = { kind: `refused` };
                    return;
                }
                status.value = { kind: `reconnecting` };
            },
        },
    });
    const { video } = cast;

    // Out of sight is out of hand: a hold nobody can see is the agent kept waiting for nothing. (The picture's own
    // pause is the screencast's.)
    if (options.visible !== undefined) {
        watch(options.visible, (visible) => {
            if (!visible && driving.value) {
                driving.value = false;
                send({ type: `control`, driving: false });
            }
        });
    }

    watch(
        sandbox,
        () => {
            cast.live.close();
            // The old socket's close handed that desktop back; the next one is not being driven yet.
            driving.value = false;
            hold.set(false);
            cast.reset();
            status.value = sandbox.value === undefined ? undefined : { kind: `connecting` };
            if (sandbox.value !== undefined) {
                cast.live.connect();
            }
        },
        { immediate: true },
    );

    onScopeDispose(() => {
        hold.set(false);
        cast.live.close();
    });

    return {
        status,
        width: cast.width,
        height: cast.height,
        driving,
        held,
        attachCanvas: (canvas) => video.attach(canvas),
        takeOver: () => {
            driving.value = true;
            send({ type: `control`, driving: true });
        },
        handBack: () => {
            driving.value = false;
            send({ type: `control`, driving: false });
        },
        onPointer: (action, event, picture) => {
            const message = cast.pointerAt(action, event, picture);
            if (message !== undefined) {
                sendInput(message);
            }
        },
        onWheel: (event, picture) => {
            if (!driving.value) {
                return;
            }
            event.preventDefault();
            const notches = wheel(event);
            const at = notches === undefined ? undefined : pointerMessage(`move`, event, picture, cast.width.value, cast.height.value);
            if (notches !== undefined && at !== undefined) {
                sendInput({ ...at, action: `wheel`, ...notches });
            }
        },
        onKeyDown: (event) => {
            const message = driving.value ? keyMessage(event) : undefined;
            if (message !== undefined) {
                event.preventDefault();
                sendInput(message);
            }
        },
        onPaste: (event) => {
            const text = event.clipboardData?.getData(`text/plain`);
            if (!driving.value || text === undefined || text === ``) {
                return;
            }
            event.preventDefault();
            sendInput({ type: `text`, text });
        },
    };
};
