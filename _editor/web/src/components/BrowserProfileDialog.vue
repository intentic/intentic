<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeOf } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { FRAME_H264_KEY } from "../composables/browser/frameUrls";
import { keyIntent, type KeyFrame } from "../composables/browser/keyIntent";
import { pointerFrame, type PointerAction } from "../composables/browser/pointerFrame";
import { videoSink } from "../composables/browser/videoSink";
import { socketUrl as wsSocketUrl } from "../composables/sandbox/wsTicket";

/* ONE CONNECTED ACCOUNT's own Chromium, in the user's hands. Opens the daemon's /system/browser-profile
 * WebSocket: the daemon runs that account's persistent profile headed on a virtual X display of its own and
 * sends that DISPLAY here as H.264, while the user's mouse and keyboard go back over the same socket and are
 * replayed into it through XTEST. Modeled on terminalSession.ts (same token+connect query-string auth over the
 * sandbox's tunnel).
 *
 * `capability` is the connection this window belongs to, not the site: one site can be connected several times
 * over (a work Reddit and a personal one), each with its own profile, so the connection is what identifies the
 * browser to open. `label` is what the user sees, and it names the ACCOUNT for the same reason: two windows onto
 * one site have to be tellable apart.
 *
 * `login` is the first visit: it opens the site's sign-in page, the user signs in (incl. 2FA/CAPTCHA) and
 * clicks "I'm done", and the daemon keeps the logged-in profile so the agent's browser tools reuse it.
 * `browse` is every visit after that: the SAME profile, already signed in, opened on the site's home page
 * for the user to do something in themselves. One component because it is one browser and one wire, and the two
 * differ now in only two things: where it starts, and whether finishing re-attests the account.
 *
 * THERE USED TO BE A THIRD. Browsing needed an address bar, drawn here in HTML and wired back to Playwright
 * navigations, because the picture was one page's compositor surface with none of the browser's own chrome in
 * it. The picture is the WINDOW now, so the real address bar and the real back button are in it and the owner
 * clicks them — which is also why the drop-down menu this file used to draw for an open <select> is gone. */

const props = defineProps<{ visible: boolean; capability: string; label: string; mode: "login" | "browse" }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "done"): void }>();

/* Pointer moves are throttled to roughly one display frame. This was 40ms, which is 25 Hz — a ceiling on how
 * responsive the pointer could be BEFORE the network had its turn, and coarse enough that a drag visited a
 * handful of points instead of tracing the path the hand took. */
const MOVE_THROTTLE_MS = 16;
// How long a Ctrl+C waits for the remote page to answer with its selection before the keystroke goes on
// without it. Long enough for a round trip through the tunnel, short enough not to strand the keyboard.
const SELECTION_TIMEOUT_MS = 1500;

// Whether anything has been painted yet, which is what the spinner is waiting on. The picture lives in the
// canvas rather than in a reactive value, so this is the only thing about it Vue needs to know.
const painting = ref(false);
// The decoder the picture is painted through, and the canvas it paints into (connected on mount below).
const video = videoSink((message) => {
    status.value = "error";
    errorMsg.value = noticeOf(message);
});
const status = ref<"connecting" | "ready" | "saving" | "error">("connecting");
const errorMsg = ref<NoticeModel>();
/* The shape of the picture, which the `ready` frame replaces with the daemon's own numbers. These defaults
 * exist only for the second before that lands, and they are the WINDOW's proportions rather than a page's: this
 * surface is always the video path (the route refuses without a display to grab), so the picture includes the
 * browser's chrome and is correspondingly taller. Defaulting to a page's 1280x800 made the box visibly change
 * height the moment the browser connected, which is a reflow under the reader's eyes for no reason. */
const viewW = ref(1280);
const viewH = ref(880);
const surface = ref<HTMLElement>();
const canvasEl = ref<HTMLCanvasElement>();
// The canvas mounts with the dialog and the decoder outlives it, so the two are connected here.
watch(canvasEl, (canvas) => video.attach(canvas));
let socket: WebSocket | undefined;
let lastMove = 0;
// The Ctrl+C in flight, waiting on the page's answer. One at a time: a second press before the first came back
// is the same question asked twice.
let pendingSelection: ((text: string) => void) | undefined;
const browsing = computed(() => props.mode === "browse");

const sendMsg = (message: object): void => {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
};

const close = (): void => {
    // A copy waiting on a socket that is going away answers empty rather than hanging until its timeout.
    pendingSelection?.("");
    pendingSelection = undefined;
    socket?.close();
    socket = undefined;
};

/* Attached, and now the client knows what it is attached to: the size of the picture (which is the window's,
 * chrome included, and therefore the space a click's coordinates are in) and the codec to build a decoder for.
 * The codec is READ OUT OF THE STREAM by the daemon rather than agreed in advance — see videocast.ts for the
 * bug that guessing it produces, which is a black picture and no error worth reading. */
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

// Everything on this socket that is not a picture. Its own function so the message listener stays a fork between
// the two kinds rather than a branch per message type stacked on top of it.
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
    // Frames arrive as binary; everything else on this socket is JSON, and `event.data` tells them apart.
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("message", (event) => {
        // A coded frame: one tag byte (keyframe or delta) then the access unit, straight into the decoder.
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
    // A decoder holds buffers from the stream it was built for, so a dialog opened and closed all afternoon
    // would otherwise keep them for the life of the document.
    video.close();
});

/* Every pointer event on the picture, built by the shared rule (pointerFrame) so this window and the agent's
 * browser view describe a drag, a double-click and a Ctrl+click the same way. Nothing to map before the first
 * frame paints, which is what the missing image means. */
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
// Ask the page what it has selected. Answered by the daemon's `selection` frame; the timeout is what keeps a
// slow tunnel from stranding the keystroke that asked.
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

/* COPY AND CUT, ACROSS THE GAP. Copying inside that Chromium puts text on the SANDBOX's clipboard, which the
 * user's machine can't read, so the selection is fetched and written to their own clipboard here. The chord
 * still goes to the page afterwards (its own handlers may care), and only afterwards: a cut that ran first
 * would have deleted the very text being read. */
const copyOut = async (chord: KeyFrame): Promise<void> => {
    const text = await askSelection();
    if (text !== "") {
        // Unavailable outside a secure context, and refusable: a failed write must not eat the keystroke.
        await navigator.clipboard?.writeText(text).catch(() => undefined);
    }
    sendMsg(chord);
};

// Which half of the keyboard this keystroke belongs to is keyIntent's decision: see that module for why a
// paste is left to the host and a select-all is not.
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

// A PASSWORD IS PASTED, NOT TYPED, which makes this the one input a sign-in cannot do without. The Chromium at
// the far end has its own clipboard inside the sandbox and nothing on the user's machine can write to it, so
// the chord is left to the host browser (keyIntent's one deliberate exemption) and the text it hands us is
// typed into the remote display as text. Same rule in useBrowserView for the agent's browser.
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
// Hand the window back: the daemon closes Chromium (flushing the profile to disk) and answers `saved`. A socket
// that never opened has nothing to flush and would leave the button spinning at a daemon that isn't listening.
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

        <!-- THERE IS NO ADDRESS BAR HERE ANY MORE, and its absence is the design rather than a loss. It existed
             because the picture was one page's compositor surface, so Chromium's own chrome was not in it and
             a URL field, a back button and a reload button had to be redrawn in HTML and wired back to
             Playwright navigations. The picture is the WINDOW now, so the real address bar and the real back
             button are in it, and the owner clicks them. -->
        <!-- CAPPED AS WELL AS PROPORTIONED, because `aspect-ratio` on a full-width box derives its HEIGHT and
             will happily derive one taller than the modal. The picture then runs past the bottom edge and the
             dialog scrolls — on a surface whose whole purpose is being driven, where the wheel belongs to the
             remote browser (`@wheel.prevent` below), so the scrollbar it just created is one the reader cannot
             use over the picture itself. `max-h` lets it shrink instead, and `mx-auto` keeps it centred when
             the height is what binds; the canvas inside is `object-contain`, so a shorter box letterboxes
             rather than distorting. The window is taller than a page (it has the browser's chrome in it), which
             is what made this start mattering. -->
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
            <!-- The whole browser window, decoded from H.264. Nothing here draws a pointer: the one in the
                 picture is the X server's own, at the place the owner moved it, in the shape Chromium gave it,
                 so `cursor-none` hides the local arrow rather than showing two of them half a frame apart. -->
            <canvas v-show="painting" ref="canvasEl" class="h-full w-full cursor-none object-contain" />
            <div v-if="!painting" class="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted">
                <Icon name="spinner" spin />
                <span>{{ status === "error" ? "Couldn't start the browser." : "Starting the browser…" }}</span>
            </div>
        </div>

        <template #footer>
            <!-- Browsing ends by closing, and the daemon flushes the profile on the way out, so there is one
                 button, not a Cancel that would suggest the visit could be undone. -->
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
