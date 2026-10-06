<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { FRAME_WEBP, videoTag } from "../../browsers/frameUrls";
import { keyIntent, type BrowserCommand, type KeyFrame } from "../../browsers/keyIntent";
import { pointerFrame, type PointerAction } from "../../browsers/pointerFrame";
import { selectionCopy } from "../../browsers/selectionCopy";
import { videoSink } from "../../browsers/videoSink";
import { useLiveSocket, webSocketChannel } from "../../../client/session/liveSocket";
import { socketUrl as wsSocketUrl } from "../../sandbox/session/wsTicket";
import { useT } from "@intentic/ui/i18n";

// One connected account's Chromium, driven live over /system/browser-profile (video of the page's viewport in, input
// replayed via XTEST and CDP). `capability` picks which connection's browser to open, since a site may be connected
// more than once; `label` names the account. `login` opens sign-in; `browse` reopens the same signed-in profile. The
// socket is a live one (liveSocket.ts): pinged, and redialled after a drop, which reopens the same profile.

const t = useT();

const props = defineProps<{ visible: boolean; capability: string; label: string; mode: "login" | "browse" }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "done"): void }>();

// Throttles pointer moves to roughly one display frame, so a drag isn't traced at network-call granularity.
const MOVE_THROTTLE_MS = 16;
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
let lastMove = 0;
// Keystrokes go to the display while Chromium's find bar has them.
let rawKeys = false;
let resizeTimer: number | undefined;
let observer: ResizeObserver | undefined;
const browsing = computed(() => props.mode === "browse");

// The live socket below, declared ahead so every verb can say something on it.
const sendMsg = (message: object): void => live.send(message);
// Ctrl+C over the picture puts the page's selection on the user's own clipboard.
const copy = selectionCopy(sendMsg);

// The box inside the surface's border, where the canvases are, so the viewport is exactly what the modal shows
// rather than scaled into it: the border box is two pixels larger each way, which resampled every pixel of the picture.
const askSize = (): void => {
    const box = surface.value;
    if (box === undefined || box.clientWidth < 1 || box.clientHeight < 1) {
        return;
    }
    sendMsg({ type: "resize", width: box.clientWidth, height: box.clientHeight });
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
    copy.cancel();
    live.close();
};

// Sets the picture's size and configures the decoder. Codec is read out of the stream by the daemon rather than
// assumed; a fresh `ready` also follows every resize, since that is a fresh stream.
const onReady = (message: { width?: number; height?: number; scale?: number; codec?: string }): void => {
    const first = status.value !== "ready";
    status.value = "ready";
    errorMsg.value = undefined;
    viewW.value = message.width ?? viewW.value;
    viewH.value = message.height ?? viewH.value;
    viewScale.value = message.scale !== undefined && message.scale > 0 ? message.scale : 1;
    video.configure(message.codec ?? "");
    if (first) {
        surface.value?.focus();
        askSize();
    }
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
            copy.answer(message.text);
            break;
        case "saved":
            onSaved();
            break;
        case "pong":
            live.ponged();
            break;
        case "error":
            fail(noticeOf(message.message ?? t(`capabilities.browserProfileDialog.couldntStartBrowser`)));
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

// What the window says while it is not showing the picture: starting (again), or why it stopped for good.
const restart = (): void => {
    status.value = "connecting";
    painting.value = false;
};
const fail = (notice: NoticeModel): void => {
    live.end();
    status.value = "error";
    errorMsg.value = notice;
};

// The daemon closes with this when it refuses the window outright (a revoked ticket, an unknown account, a profile open
// elsewhere); asking again would get the same answer.
const CLOSE_REFUSED = 1008;

const live = useLiveSocket<string>({
    mint: () => wsSocketUrl(`/system/browser-profile`, { capability: props.capability, mode: props.mode }),
    open: webSocketChannel({ text: handleJson, binary: takePicture }),
    // A daemon from before this route answered pings says nothing back, and a still sign-in page sends no frames.
    staleCheck: "once-ponged",
    // A session that couldn't be minted is said, and asked again on the ladder rather than left as a dead window.
    onMintFailed: (error) => {
        restart();
        errorMsg.value = noticeFrom(error, t(`capabilities.browserProfileDialog.couldntStartBrowser`));
    },
    onUnreachable: () => {
        restart();
        errorMsg.value = noticeOf(t(`capabilities.browserProfileDialog.couldntStartBrowser`));
    },
    onDrop: (code) => {
        if (status.value === "saving") {
            // The profile may or may not have been saved; a fresh window would hide which.
            fail(noticeOf(t(`capabilities.browserProfileDialog.droppedWhileSaving`)));
        } else if (code === CLOSE_REFUSED || status.value === "error") {
            // Refused, or the daemon already said why it is giving up (`error`, then a close).
            fail(errorMsg.value ?? noticeOf(t(`capabilities.browserProfileDialog.couldntStartBrowser`)));
        } else {
            restart();
        }
    },
});

const connect = (): void => {
    restart();
    errorMsg.value = undefined;
    live.connect();
};

// Immediate, since an instance can mount already visible (a remount under it, an HMR replacement): waiting for a flip
// that already happened leaves a dialog open on no socket, with no picture and no way to drive it.
watch(
    () => props.visible,
    (open) => (open ? connect() : close()),
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
    if (intent.kind === "device") {
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
        void copy.copyOut(intent.frame, surface.value);
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
    if (!live.isOpen()) {
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
