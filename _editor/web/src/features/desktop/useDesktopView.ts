import { errorMessage } from "@intentic/base/errors";
import { onScopeDispose, ref, type Ref, watch } from "vue";
import { z } from "zod";
import { keyMessage, pointerMessage, wheelGauge, type DesktopKey, type DesktopMouse, type DesktopPointerAction, type DesktopText } from "./desktopInput";
import { videoTag } from "../browsers/frameUrls";
import { canDecodeVideo, videoSink } from "../browsers/videoSink";
import { useLiveSocket, webSocketChannel } from "../../client/session/liveSocket";
import { socketUrl } from "../sandbox/session/wsTicket";

// The sandbox's own desktop over /system/desktop-view (the daemon's desktop/desktop-view.ts): H.264 of the whole
// display into a canvas, and, once the owner takes over, their pointer and keys back onto it. One desktop per sandbox,
// so the only thing followed is which sandbox is active; nothing reaches the desktop until the owner takes over.

// The desktop's size (agent-desktop.ts DESKTOP_SIZE), assumed only until `ready` says.
const DESKTOP_WIDTH = 1280;
const DESKTOP_HEIGHT = 800;
// One display frame; each move is a few dozen bytes of JSON.
const MOVE_THROTTLE_MS = 16;
// How long the hold outlives the owner's last input (agent-desktop.ts OWNER_IDLE_MS). The daemon announces a hold when
// it starts and never when it lapses, so the view lets it lapse by the same clock rather than show one that is gone.
export const HOLD_MS = 20_000;
// What the daemon closes with when the ticket is not enough to drive the desktop: a policy refusal, not a drop.
const CLOSE_REFUSED = 1008;

// What to say while there is no picture; the view words it. `detail` is the failure's own sentence.
export type DesktopStatus =
    | { readonly kind: `connecting` | `reconnecting` | `unreachable` | `waiting` | `unsupported` | `refused` }
    | { readonly kind: `authFailed` | `failed`; readonly detail: string };

// Everything this view says to the daemon.
type Outgoing =
    | { readonly type: `ping` | `pause` | `resume` }
    | { readonly type: `control`; readonly driving: boolean }
    | DesktopMouse
    | DesktopKey
    | DesktopText;

// Everything the daemon says besides a picture, read loosely: a field this build does not know is ignored, not refused.
const Incoming = z.object({
    type: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
    codec: z.string().optional(),
    owner: z.boolean().optional(),
    message: z.string().optional(),
});

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

// Follows `sandbox` (any value that changes when the active sandbox does): a change tears the socket down and dials
// the new one's desktop. Undefined dials nothing.
export const useDesktopView = (sandbox: Ref<string | undefined>): DesktopView => {
    const status = ref<DesktopStatus | undefined>({ kind: `connecting` });
    const width = ref(DESKTOP_WIDTH);
    const height = ref(DESKTOP_HEIGHT);
    const driving = ref(false);
    const held = ref(false);
    const hold = holdClock(held);
    const video = videoSink(() => {
        status.value = { kind: `unsupported` };
    });
    const wheel = wheelGauge();
    let lastMove = 0;

    // The live socket below, declared ahead so every verb can say something on it.
    const send = (message: Outgoing): void => live.send(message);

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

    const handleJson = (raw: string): void => {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // allow(silent-catch): a frame that is not JSON is none of the view's messages; the next one is read as usual.
            return;
        }
        const read = Incoming.safeParse(parsed);
        if (!read.success) {
            return;
        }
        const message = read.data;
        if (message.type === `ready`) {
            width.value = message.width ?? width.value;
            height.value = message.height ?? height.value;
            if (canDecodeVideo()) {
                video.configure(message.codec ?? ``);
            }
            status.value = { kind: canDecodeVideo() ? `waiting` : `unsupported` };
        } else if (message.type === `held`) {
            hold.set(message.owner === true);
        } else if (message.type === `error`) {
            // The desktop could not start; dialling again would only ask the same question.
            live.end();
            status.value = { kind: `failed`, detail: message.message ?? `` };
        }
    };

    // One binary message: a tag byte (3 keyframe, 4 delta; videocast.ts encodeVideo) and the frame.
    const takePicture = (data: ArrayBuffer): void => {
        const bytes = new Uint8Array(data);
        const coded = videoTag(bytes[0]);
        if (coded !== undefined) {
            video.push(bytes.subarray(1), coded.key, coded.quiet);
            status.value = undefined;
        }
    };

    // Nobody is looking: the daemon stops grabbing the display until the view is visible again.
    const syncVisibility = (): void => send({ type: document.hidden ? `pause` : `resume` });
    document.addEventListener(`visibilitychange`, syncVisibility);

    const live = useLiveSocket<string, Outgoing>({
        mint: () => socketUrl(`/system/desktop-view`),
        open: webSocketChannel({ text: handleJson, binary: takePicture }),
        onMintFailed: (error) => {
            status.value = { kind: `authFailed`, detail: errorMessage(error) };
        },
        onUnreachable: () => {
            status.value = { kind: `unreachable` };
        },
        onOpen: () => {
            syncVisibility();
            // A drop handed the desktop back; an owner still driving takes it again rather than clicking into nothing.
            if (driving.value) {
                send({ type: `control`, driving: true });
            }
        },
        onDrop: (code) => {
            hold.set(false);
            if (code === CLOSE_REFUSED) {
                live.end();
                status.value = { kind: `refused` };
                return;
            }
            status.value = { kind: `reconnecting` };
        },
    });

    watch(
        sandbox,
        () => {
            live.close();
            // The old socket's close handed that desktop back; the next one is not being driven yet.
            driving.value = false;
            hold.set(false);
            video.close();
            status.value = sandbox.value === undefined ? undefined : { kind: `connecting` };
            if (sandbox.value !== undefined) {
                live.connect();
            }
        },
        { immediate: true },
    );

    onScopeDispose(() => {
        document.removeEventListener(`visibilitychange`, syncVisibility);
        hold.set(false);
        live.close();
        video.close();
    });

    return {
        status,
        width,
        height,
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
            // Enough to keep a 1000 Hz mouse from flooding the socket; a press carries its own position anyway.
            const now = Date.now();
            if (action === `move` && now - lastMove < MOVE_THROTTLE_MS) {
                return;
            }
            lastMove = action === `move` ? now : lastMove;
            const message = pointerMessage(action, event, picture, width.value, height.value);
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
            const at = notches === undefined ? undefined : pointerMessage(`move`, event, picture, width.value, height.value);
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
