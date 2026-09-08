<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeOf } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { FRAME_H264_KEY } from "../../browsers/frameUrls";
import { keyIntent, type KeyFrame } from "../../browsers/keyIntent";
import { pointerFrame, type PointerAction } from "../../browsers/pointerFrame";
import { videoSink } from "../../browsers/videoSink";
import { socketUrl as wsSocketUrl } from "../../sandbox/client/wsTicket";

// One connected account's Chromium, driven live over /system/browser-profile (video in, input replayed via XTEST).
// `capability` picks which connection's browser to open, since a site may be connected more than once; `label`
// names the account. `login` opens sign-in; `browse` reopens the same signed-in profile.

const props = defineProps<{ visible: boolean; capability: string; label: string; mode: "login" | "browse" }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "done"): void }>();

// Throttles pointer moves to roughly one display frame, so a drag isn't traced at network-call granularity.
const MOVE_THROTTLE_MS = 16;
// How long a Ctrl+C waits for the page's selection before the keystroke proceeds without it.
const SELECTION_TIMEOUT_MS = 1500;

// Whether anything has painted yet; the picture itself lives in the canvas, not in reactive state.
const painting = ref(false);
// Decoder painting into the canvas connected below; reports back through `status`/`errorMsg`.
const video = videoSink((message) => {
    status.value = "error";
    errorMsg.value = noticeOf(message);
});
const status = ref<"connecting" | "ready" | "saving" | "error">("connecting");
const errorMsg = ref<NoticeModel>();
// Default size until `ready` reports the real one; window proportions (chrome included), not a bare page's.
const viewW = ref(1280);
const viewH = ref(880);
const surface = ref<HTMLElement>();
const canvasEl = ref<HTMLCanvasElement>();
// Canvas mounts with the dialog; the decoder outlives it, so the two are wired together here.
watch(canvasEl, (canvas) => video.attach(canvas));
let socket: WebSocket | undefined;
let lastMove = 0;
// Ctrl+C in flight, waiting on the page's answer; one at a time.
let pendingSelection: ((text: string) => void) | undefined;
const browsing = computed(() => props.mode === "browse");

const sendMsg = (message: object): void => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
};

const close = (): void => {
    // A pending copy on a closing socket resolves empty instead of hanging to its timeout.
    pendingSelection?.("");
    pendingSelection = undefined;
    socket?.close();
    socket = undefined;
};

// Sets the picture's size (the window's, chrome included, so it matches click coordinates) and configures the
// decoder. Codec is read out of the stream by the daemon rather than assumed.
const onReady = (message: { width?: number; height?: number; codec?: string }): void => {
    status.value = "ready";
    viewW.value = message.width ?? viewW.value;
    viewH.value = message.height ?? viewH.value;
    video.configure(message.codec ?? "");
    surface.value?.focus();
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
    const message = JSON.parse(raw) as { type: string; width?: number; height?: number; codec?: string; message?: string; text?: string };
    switch (message.type) {
        case "ready":
            onReady(message);
            break;
        case "selection":
            onSelection(message.text);
            break;
        case "saved":
            onSaved();
            break;
        case "error":
            status.value = "error";
            errorMsg.value = noticeOf(message.message ?? "The browser couldn't be opened.");
            break;
        default:
            break;
    }
};

const connect = async (): Promise<void> => {
    status.value = "connecting";
    errorMsg.value = undefined;
    painting.value = false;
    const url = await wsSocketUrl(`/system/browser-profile`, { capability: props.capability, mode: props.mode });
    if (url === undefined) {
        status.value = "error";
        errorMsg.value = noticeOf("Sandbox isn't reachable, or you're not signed in.");
        return;
    }
    const ws = new WebSocket(url);
    // Frames arrive as binary; everything else on this socket is JSON, told apart by `event.data`.
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("message", (event) => {
        // A coded frame: one tag byte (keyframe or delta), then the access unit, straight into the decoder.
        if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data);
            video.push(bytes.subarray(1), bytes[0] === FRAME_H264_KEY);
            painting.value = true;
            return;
        }
        handleJson(String(event.data));
    });
    ws.addEventListener("error", () => {
        if (status.value !== "saving") {
            status.value = "error";
            errorMsg.value = errorMsg.value ?? noticeOf("Connection failed.");
        }
    });
};

watch(
    () => props.visible,
    (open) => (open ? void connect() : close()),
);
onBeforeUnmount(() => {
    close();
    // A decoder holds buffers from its stream; close it or a dialog opened/closed repeatedly leaks them.
    video.close();
});

// Every pointer event, built by the shared rule (pointerFrame) so this window and the agent's browser view describe
// drags and clicks the same way.
const sendPointer = (action: PointerAction, event: MouseEvent): void => {
    if (canvasEl.value !== undefined) {
        sendMsg(pointerFrame(action, event, canvasEl.value, viewW.value, viewH.value));
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

// Which half of the keyboard a keystroke belongs to is keyIntent's call (see that module).
const onKeyDown = (event: KeyboardEvent): void => {
    const intent = keyIntent(event);
    if (intent.kind === "host") {
        return;
    }
    event.preventDefault();
    if (intent.kind === "text") {
        sendMsg({ type: "text", text: intent.text });
    } else if (intent.kind === "key") {
        sendMsg(intent.frame);
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
        :header="browsing ? `${label}, your browser` : `Log in to ${label}`"
        @update:open="!$event && cancel()"
    >
        <p class="mb-3 text-xs text-muted">
            <template v-if="browsing">
                This is the signed-in browser the agent uses for {{ label }}: do whatever you need in it. The agent can't use it while this window is
                open, and anything you change here it sees next time.
            </template>
            <template v-else>
                Sign in as you would normally: including any 2FA. When you're on your logged-in home page, click
                <b>I'm done</b> and the agent will act as you here. Your session stays inside your sandbox.
            </template>
        </p>

        <Notice v-if="errorMsg" :of="errorMsg" class="mb-3" />

        <!--
            No address bar any more: the picture is now the whole window, so the real address bar and back button are
            Chromium's own.
        -->
        <!--
            Capped, not just proportioned: aspect-ratio alone could derive a height taller than the modal, creating a
            scrollbar over a surface whose wheel belongs to the remote browser. `max-h`+`object-contain` shrink and
            letterbox
            instead.
        -->
        <div
            ref="surface"
            tabindex="0"
            class="relative mx-auto max-h-[calc(var(--height-panel-lg)-5rem)] w-full select-none overflow-hidden rounded-lg border border-line bg-canvas outline-none"
            :style="{ aspectRatio: `${viewW} / ${viewH}` }"
            @mousemove="onMouseMove"
            @mousedown="onMouseDown"
            @mouseup="onMouseUp"
            @wheel.prevent="onWheel"
            @keydown="onKeyDown"
            @paste="onPaste"
            @contextmenu.prevent
        >
            <!--
                Whole window decoded from H.264; the only pointer shown is the X server's own, so `cursor-none` hides
                the local
                one.
            -->
            <canvas v-show="painting" ref="canvasEl" class="h-full w-full cursor-none object-contain" />
            <div v-if="!painting" class="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted">
                <Icon name="spinner" spin />
                <span>{{ status === "error" ? "Couldn't start the browser." : "Starting the browser…" }}</span>
            </div>
        </div>

        <template #footer>
            <!--
                Browsing ends by closing (the daemon flushes the profile), so one button, not a Cancel implying it's
                undoable.
            -->
            <Button v-if="browsing" label="Close" :loading="status === 'saving'" @click="finish">
                <template #icon><Icon name="check" /></template>
            </Button>
            <template v-else>
                <Button label="Cancel" severity="secondary" :text="true" @click="cancel" />
                <Button label="I'm done" :disabled="status !== 'ready'" :loading="status === 'saving'" @click="finish">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </template>
        </template>
    </Modal>
</template>
