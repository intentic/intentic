<script setup lang="ts">
import { cmp } from "@intentic/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { onBeforeUnmount, ref, watch } from "vue";
import { viewportCoords } from "../composables/browser/viewportCoords";
import { socketUrl as wsSocketUrl } from "../composables/sandbox/wsTicket";

/* Guided browser login for a `browser`-kind capability. Opens the daemon's /system/browser-login WebSocket: the
 * daemon drives a real (headless) Chromium at the platform's sign-in page and screencasts it here as image frames;
 * we forward the user's mouse + keyboard back over the same socket. The user signs in (incl. 2FA/CAPTCHA), clicks
 * "I'm done", and the daemon persists the logged-in profile so the agent's browser tools reuse it. Modeled on
 * terminalSession.ts (same token+connect query-string auth over the sandbox's tunnel). */

const props = defineProps<{ visible: boolean; platform: string; label: string }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "done"): void }>();

// Keys forwarded as key events; everything printable rides as an insertText `text` frame instead.
const SPECIAL_KEYS = new Set(["Enter", "Backspace", "Tab", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
const MOVE_THROTTLE_MS = 40;

const frame = ref<string>();
const status = ref<"connecting" | "ready" | "saving" | "error">("connecting");
const errorMsg = ref<string>();
const viewW = ref(1280);
const viewH = ref(800);
const surface = ref<HTMLElement>();
const imgEl = ref<HTMLImageElement>();
let socket: WebSocket | undefined;
let lastMove = 0;

const sendMsg = (message: object): void => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
};

const close = (): void => {
    socket?.close();
    socket = undefined;
};

const connect = async (): Promise<void> => {
    status.value = "connecting";
    errorMsg.value = undefined;
    frame.value = undefined;
    const url = await wsSocketUrl(`/system/browser-login`, { platform: props.platform });
    if (url === undefined) {
        status.value = "error";
        errorMsg.value = "Sandbox isn't reachable, or you're not signed in.";
        return;
    }
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
            type: string;
            data?: string;
            format?: string;
            width?: number;
            height?: number;
            message?: string;
        };
        // The encoding alternates: a cheap jpeg while the page paints, a sharp webp once it settles — so the
        // frame says which it is rather than the client assuming (screencast.ts).
        if (message.type === "frame" && message.data !== undefined && message.format !== undefined) {
            frame.value = `data:image/${message.format};base64,${message.data}`;
        } else if (message.type === "ready") {
            status.value = "ready";
            viewW.value = message.width ?? viewW.value;
            viewH.value = message.height ?? viewH.value;
            surface.value?.focus();
        } else if (message.type === "saved") {
            emit("done");
            close();
            emit("update:visible", false);
        } else if (message.type === "error") {
            status.value = "error";
            errorMsg.value = message.message ?? "Login failed.";
        }
    });
    ws.addEventListener("error", () => {
        if (status.value !== "saving") {
            status.value = "error";
            errorMsg.value = errorMsg.value ?? "Connection failed.";
        }
    });
};

watch(
    () => props.visible,
    (open) => (open ? void connect() : close()),
);
onBeforeUnmount(close);

// Map a pointer event to the daemon viewport's coordinate space — viewportCoords is the shared rule, and this
// only supplies the image and the size the `ready` frame reported. Nothing to map before the first frame paints.
const coords = (event: MouseEvent): { x: number; y: number } =>
    imgEl.value === undefined ? { x: 0, y: 0 } : viewportCoords(event, imgEl.value, viewW.value, viewH.value);

const onMouseMove = (event: MouseEvent): void => {
    const now = Date.now();
    if (now - lastMove < MOVE_THROTTLE_MS) {
        return;
    }
    lastMove = now;
    const { x, y } = coords(event);
    sendMsg({ type: "mouse", action: "move", x, y });
};
const onMouseDown = (event: MouseEvent): void => {
    surface.value?.focus();
    const { x, y } = coords(event);
    sendMsg({ type: "mouse", action: "down", x, y, button: event.button });
};
const onMouseUp = (event: MouseEvent): void => {
    const { x, y } = coords(event);
    sendMsg({ type: "mouse", action: "up", x, y, button: event.button });
};
const onWheel = (event: WheelEvent): void => {
    const { x, y } = coords(event);
    sendMsg({ type: "mouse", action: "wheel", x, y, deltaX: event.deltaX, deltaY: event.deltaY });
};
const onKeyDown = (event: KeyboardEvent): void => {
    // Let real shortcuts (copy/paste/devtools) through; we only forward plain typing + a few control keys.
    if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
    }
    if (event.key.length === 1) {
        sendMsg({ type: "text", text: event.key });
        event.preventDefault();
    } else if (SPECIAL_KEYS.has(event.key)) {
        sendMsg({ type: "key", key: event.key });
        event.preventDefault();
    }
};

const finish = (): void => {
    status.value = "saving";
    sendMsg({ type: "done" });
};
const cancel = (): void => {
    close();
    emit("update:visible", false);
};
</script>

<template>
    <Dialog
        :visible="visible"
        :modal="true"
        :draggable="false"
        :dismissable-mask="false"
        :style="{ width: '64rem', maxWidth: '95vw' }"
        :header="`Log in to ${label}`"
        @update:visible="!$event && cancel()"
    >
        <p class="mb-3 text-xs text-muted">
            Sign in as you would normally — including any 2FA. When you're on your logged-in home page, click
            <b>I'm done</b> and the agent will act as you here. Your session stays inside your sandbox.
        </p>

        <div v-if="errorMsg" :class="cmp.alertDanger('mb-3')">{{ errorMsg }}</div>

        <div
            ref="surface"
            tabindex="0"
            class="relative w-full select-none overflow-hidden rounded-lg border border-line bg-canvas outline-none"
            :style="{ aspectRatio: `${viewW} / ${viewH}` }"
            @mousemove="onMouseMove"
            @mousedown="onMouseDown"
            @mouseup="onMouseUp"
            @wheel.prevent="onWheel"
            @keydown="onKeyDown"
            @contextmenu.prevent
        >
            <img v-if="frame" ref="imgEl" :src="frame" alt="" draggable="false" class="h-full w-full object-contain" />
            <div v-else class="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted">
                <Icon name="spinner" spin />
                <span>{{ status === "error" ? "Couldn't start the browser." : "Starting the browser…" }}</span>
            </div>
        </div>

        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" @click="cancel" />
            <Button label="I'm done" :disabled="status !== 'ready'" :loading="status === 'saving'" @click="finish">
                <template #icon><Icon name="check" /></template>
            </Button>
        </template>
    </Dialog>
</template>
