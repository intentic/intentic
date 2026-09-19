<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeOf } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { FRAME_WEBP, videoTag } from "../../browsers/frameUrls";
import { keyIntent, type BrowserCommand, type KeyFrame } from "../../browsers/keyIntent";
import { pointerFrame, type PointerAction } from "../../browsers/pointerFrame";
import { videoSink } from "../../browsers/videoSink";
import { socketUrl as wsSocketUrl } from "../../sandbox/client/wsTicket";
import { useT } from "@intentic/ui/i18n";

// One connected account's Chromium, driven live over /system/browser-profile (video of the page's viewport in, input
// replayed via XTEST and CDP). `capability` picks which connection's browser to open, since a site may be connected
// more than once; `label` names the account. `login` opens sign-in; `browse` reopens the same signed-in profile.

const t = useT();

const props = defineProps<{ visible: boolean; capability: string; label: string; mode: "login" | "browse" }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "done"): void }>();

// Throttles pointer moves to roughly one display frame, so a drag isn't traced at network-call granularity.
const MOVE_THROTTLE_MS = 16;
// How long a Ctrl+C waits for the page's selection before the keystroke proceeds without it.
const SELECTION_TIMEOUT_MS = 1500;
// A size is asked once the surface has held still this long; the modal only changes shape with the window.
const RESIZE_DEBOUNCE_MS = 250;

// Whether anything has painted yet; the picture itself lives in the canvas, not in reactive state.
const painting = ref(false);
// Decoder painting into the canvases connected below; reports back through `status`/`errorMsg`.
const video = videoSink((message) => {
    status.value = "error";
    errorMsg.value = noticeOf(message);
});
const status = ref<"connecting" | "ready" | "saving" | "error">("connecting");
const errorMsg = ref<NoticeModel>();
// The picture's size in display pixels, and display pixels per CSS pixel, both off `ready`; pointer coordinates are
// measured against the first.
const viewW = ref(1280);
const viewH = ref(800);
const viewScale = ref(1);
// What the page shows under the pointer; the picture carries no cursor of its own.
const cursor = ref("default");
const surface = ref<HTMLElement>();
// Null, not undefined, once the dialog's content has unmounted: that is what Vue writes to a template ref.
const canvasEl = ref<HTMLCanvasElement | null>(null);
const stillEl = ref<HTMLCanvasElement | null>(null);
// Canvases mount with the dialog; the decoder outlives them, so the two are wired together here.
watch([canvasEl, stillEl], ([canvas, still]) => video.attach(canvas, still));
let socket: WebSocket | undefined;
let lastMove = 0;
// Ctrl+C in flight, waiting on the page's answer; one at a time.
let pendingSelection: ((text: string) => void) | undefined;
// Keystrokes go to the display while Chromium's find bar has them.
let rawKeys = false;
let resizeTimer: number | undefined;
let observer: ResizeObserver | undefined;
const browsing = computed(() => props.mode === "browse");

const sendMsg = (message: object): void => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
};

// The surface's own box, so the viewport is exactly what the modal shows rather than scaled into it.
const askSize = (): void => {
    const box = surface.value?.getBoundingClientRect();
    if (box === undefined || box.width < 1 || box.height < 1) {
        return;
    }
    sendMsg({ type: "resize", width: Math.round(box.width), height: Math.round(box.height) });
};

watch(surface, (element) => {
    observer?.disconnect();
    observer = undefined;
    if (element === undefined) {
        return;
    }
    observer = new ResizeObserver(() => {
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(askSize, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(element);
});

const close = (): void => {
    // A pending copy on a closing socket resolves empty instead of hanging to its timeout.
    pendingSelection?.("");
    pendingSelection = undefined;
    socket?.close();
    socket = undefined;
};

// Sets the picture's size and configures the decoder. Codec is read out of the stream by the daemon rather than
// assumed; a fresh `ready` also follows every resize, since that is a fresh stream.
const onReady = (message: { width?: number; height?: number; scale?: number; codec?: string }): void => {
    const first = status.value !== "ready";
    status.value = "ready";
    viewW.value = message.width ?? viewW.value;
    viewH.value = message.height ?? viewH.value;
    viewScale.value = message.scale !== undefined && message.scale > 0 ? message.scale : 1;
    video.configure(message.codec ?? "");
    if (first) {
        surface.value?.focus();
        askSize();
    }
};

const onSelection = (text: string | undefined): void => {
    pendingSelection?.(text ?? "");
    pendingSelection = undefined;
};

const onSaved = (): void => {
    emit("done");
    close();
    emit("update:visible", false);
};

// Everything on this socket that isn't a picture frame, kept as its own dispatch rather than inline branches.
const handleJson = (raw: string): void => {
    const message = JSON.parse(raw) as {
        type: string;
        width?: number;
        height?: number;
        scale?: number;
        codec?: string;
        message?: string;
        text?: string;
        cursor?: string;
    };
    switch (message.type) {
        case "ready":
            onReady(message);
            break;
        case "cursor":
            cursor.value = message.cursor ?? "default";
            break;
        case "selection":
            onSelection(message.text);
            break;
        case "saved":
            onSaved();
            break;
        case "error":
            status.value = "error";
            errorMsg.value = noticeOf(message.message ?? t(`capabilities.browserProfileDialog.couldntStartBrowser`));
            break;
        default:
            break;
    }
};

// A picture: one tag byte, then video (keyframe or delta, quiet or not) into the decoder, or a sharp still of the
// settled page over it.
const takePicture = (data: ArrayBuffer): void => {
    const bytes = new Uint8Array(data);
    const coded = videoTag(bytes[0]);
    if (coded !== undefined) {
        video.push(bytes.subarray(1), coded.key, coded.quiet);
        painting.value = true;
    } else if (bytes[0] === FRAME_WEBP) {
        video.still(bytes.subarray(1));
    }
};

const connect = async (): Promise<void> => {
    status.value = "connecting";
    errorMsg.value = undefined;
    painting.value = false;
    const url = await wsSocketUrl(`/system/browser-profile`, { capability: props.capability, mode: props.mode });
    if (url === undefined) {
        status.value = "error";
        errorMsg.value = noticeOf(t(`capabilities.browserProfileDialog.couldntStartBrowser`));
        return;
    }
    const ws = new WebSocket(url);
    // Frames arrive as binary; everything else on this socket is JSON, told apart by `event.data`.
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
            takePicture(event.data);
            return;
        }
        handleJson(String(event.data));
    });
    ws.addEventListener("error", () => {
        if (status.value !== "saving") {
            status.value = "error";
            errorMsg.value = errorMsg.value ?? noticeOf(t(`capabilities.browserProfileDialog.couldntStartBrowser`));
        }
    });
};

// Immediate, since an instance can mount already visible (a remount under it, an HMR replacement): waiting for a flip
// that already happened leaves a dialog open on no socket, with no picture and no way to drive it.
watch(
    () => props.visible,
    (open) => (open ? void connect() : close()),
    { immediate: true },
);
onBeforeUnmount(() => {
    close();
    observer?.disconnect();
    window.clearTimeout(resizeTimer);
    // A decoder holds buffers from its stream; close it or a dialog opened/closed repeatedly leaks them.
    video.close();
});

// Every pointer event, built by the shared rule (pointerFrame) so this window and the agent's browser view describe
// drags and clicks the same way.
// The canvas is checked, not assumed: a surface whose canvas has unmounted still carries these listeners, and a null
// ref reaches viewportCoords as a dereference inside a native event handler. A canvas still hidden by `v-show` has no
// box either, and pointerFrame answers undefined rather than the origin; nothing is sent until there is a picture to
// aim at.
const sendPointer = (action: PointerAction, event: MouseEvent): void => {
    const canvas = canvasEl.value;
    if (canvas === null) {
        return;
    }
    const frame = pointerFrame(action, event, canvas, viewW.value, viewH.value);
    if (frame !== undefined) {
        sendMsg(frame);
    }
};

const onMouseMove = (event: MouseEvent): void => {
    const now = Date.now();
    if (now - lastMove < MOVE_THROTTLE_MS) {
        return;
    }
    lastMove = now;
    sendPointer("move", event);
};
const onMouseDown = (event: MouseEvent): void => {
    surface.value?.focus();
    // A click puts the keyboard back on the page, wherever the find bar left it.
    rawKeys = false;
    sendPointer("down", event);
};
const onMouseUp = (event: MouseEvent): void => sendPointer("up", event);
const onWheel = (event: WheelEvent): void => sendPointer("wheel", event);
// Asks the page for its selection; the timeout keeps a slow tunnel from stranding the keystroke.
const askSelection = (): Promise<string> =>
    new Promise((resolve) => {
        pendingSelection?.("");
        pendingSelection = resolve;
        sendMsg({ type: "selection" });
        window.setTimeout(() => {
            if (pendingSelection === resolve) {
                pendingSelection = undefined;
                resolve("");
            }
        }, SELECTION_TIMEOUT_MS);
    });

// Copying inside that Chromium writes to the sandbox's clipboard, unreadable to the user's machine, so the
// selection is fetched and written to theirs here. The chord still reaches the page afterwards, never before (a cut
// would delete what's being read).
const copyOut = async (chord: KeyFrame): Promise<void> => {
    const text = await askSelection();
    if (text !== "") {
        // Clipboard write is unavailable outside a secure context and may be refused; don't let that eat the keystroke.
        await navigator.clipboard?.writeText(text).catch(() => undefined);
    }
    sendMsg(chord);
};

// The browser verbs this window has: history and reload, and Chromium's find bar. No tab strip here, so the tab
// verbs are nobody's.
const onCommand = (command: BrowserCommand): void => {
    if (command === "back" || command === "forward" || command === "reload") {
        sendMsg({ type: command });
    } else if (command === "find") {
        sendMsg({ type: "key", key: "f", ctrl: true, raw: true });
        rawKeys = true;
    }
};

const sendKey = (frame: KeyFrame): void => {
    sendMsg(rawKeys ? { ...frame, raw: true } : frame);
    if (rawKeys && frame.key === "Escape") {
        rawKeys = false;
    }
};

// Which half of the keyboard a keystroke belongs to is keyIntent's call (see that module).
const onKeyDown = (event: KeyboardEvent): void => {
    const intent = keyIntent(event);
    if (intent.kind === "host") {
        return;
    }
    event.preventDefault();
    if (intent.kind === "command") {
        onCommand(intent.command);
    } else if (intent.kind === "text") {
        sendMsg(rawKeys ? { type: "text", text: intent.text, raw: true } : { type: "text", text: intent.text });
    } else if (intent.kind === "key") {
        sendKey(intent.frame);
    } else {
        void copyOut(intent.frame);
    }
};

// A password is pasted, not typed: the remote Chromium's clipboard is unreachable from the user's machine, so paste
// is left to the host browser (keyIntent's one exemption) and typed into the remote display as text.
const onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined || text === "") {
        return;
    }
    event.preventDefault();
    sendMsg({ type: "text", text });
};

const cancel = (): void => {
    close();
    emit("update:visible", false);
};
// Hand the window back: the daemon flushes the profile and answers `saved`; a socket that never opened just cancels.
const finish = (): void => {
    if (socket?.readyState !== WebSocket.OPEN) {
        cancel();
        return;
    }
    status.value = "saving";
    sendMsg({ type: "done" });
};
</script>

<template>
    <Modal
        :open="visible"
        size="xl"
        :dismissable="false"
        :header="browsing ? t(`capabilities.browserProfileDialog.browser`, { label }) : t(`capabilities.browserProfileDialog.logInTo`, { label })"
        @update:open="!$event && cancel()"
    >
        <p class="mb-3 text-xs text-muted">
            <template v-if="browsing">{{ t(`capabilities.browserProfileDialog.signedInBrowserAgent`, { label }) }}</template>
            <template v-else>
                {{ t(`capabilities.browserProfileDialog.signInWouldNormally`) }}
                <b>{{ t(`capabilities.browserProfileDialog.imDone`) }}</b> {{ t(`capabilities.browserProfileDialog.agentActHereSession`) }}
            </template>
        </p>

        <Notice v-if="errorMsg" :of="errorMsg" class="mb-3" />

        <!-- The page's viewport, sized to this box: the daemon fits the browser window to it, so the picture is the page at 1:1. -->
        <div
            ref="surface"
            tabindex="0"
            class="relative mx-auto h-[calc(var(--height-panel-lg)-5rem)] w-full select-none overflow-hidden rounded-lg border border-line bg-canvas outline-none"
            :style="{ cursor }"
            @mousemove="onMouseMove"
            @mousedown="onMouseDown"
            @mouseup="onMouseUp"
            @wheel.prevent="onWheel"
            @keydown="onKeyDown"
            @paste="onPaste"
            @contextmenu.prevent
        >
            <!-- Video beneath, the sharp still of the settled page above it (videoSink); both the same box so a click aims the same. -->
            <canvas v-show="painting" ref="canvasEl" class="absolute inset-0 h-full w-full object-contain" />
            <canvas v-show="painting" ref="stillEl" class="pointer-events-none absolute inset-0 h-full w-full object-contain" />
            <div v-if="!painting" class="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted">
                <Icon name="spinner" spin />
                <span>{{
                    status === "error"
                        ? t(`capabilities.browserProfileDialog.couldntStartBrowser`)
                        : t(`capabilities.browserProfileDialog.startingBrowser`)
                }}</span>
            </div>
        </div>

        <template #footer>
            <!-- Browsing ends by closing (the daemon flushes the profile), so one button, not a Cancel implying it's undoable. -->
            <Button v-if="browsing" :label="t(`ui.action.close`)" :loading="status === 'saving'" @click="finish">
                <template #icon><Icon name="check" /></template>
            </Button>
            <template v-else>
                <Button :label="t(`ui.action.cancel`)" severity="secondary" :text="true" @click="cancel" />
                <Button
                    :label="t(`capabilities.browserProfileDialog.imDone`)"
                    :disabled="status !== 'ready'"
                    :loading="status === 'saving'"
                    @click="finish"
                >
                    <template #icon><Icon name="check" /></template>
                </Button>
            </template>
        </template>
    </Modal>
</template>
