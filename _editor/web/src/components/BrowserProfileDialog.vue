<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeOf } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import BrowserSelectMenu from "./BrowserSelectMenu.vue";
import { keyIntent, type KeyFrame } from "../composables/browser/keyIntent";
import type { SelectMenu } from "../composables/browser/useBrowserView";
import { viewportCoords } from "../composables/browser/viewportCoords";
import { socketUrl as wsSocketUrl } from "../composables/sandbox/wsTicket";

/* ONE CONNECTED ACCOUNT's own Chromium, in the user's hands. Opens the daemon's /system/browser-profile
 * WebSocket: the daemon drives that account's persistent profile on a virtual display and screencasts it here as
 * image frames; we forward the user's mouse + keyboard back over the same socket. Modeled on terminalSession.ts
 * (same token+connect query-string auth over the sandbox's tunnel).
 *
 * `capability` is the connection this window belongs to, not the site: one site can be connected several times
 * over (a work Reddit and a personal one), each with its own profile, so the connection is what identifies the
 * browser to open. `label` is what the user sees, and it names the ACCOUNT for the same reason: two windows onto
 * one site have to be tellable apart.
 *
 * `login` is the first visit: it opens the site's sign-in page, the user signs in (incl. 2FA/CAPTCHA) and
 * clicks "I'm done", and the daemon keeps the logged-in profile so the agent's browser tools reuse it.
 * `browse` is every visit after that: the SAME profile, already signed in, opened on the site's home page
 * for the user to do something in themselves. One component because it is one browser and one wire: what
 * differs is where it starts, whether finishing re-attests the account, and the address bar, which only browsing
 * needs (the screencast is the page alone, so there is no window chrome in the picture to click). */

const props = defineProps<{ visible: boolean; capability: string; label: string; mode: "login" | "browse" }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "done"): void }>();

const MOVE_THROTTLE_MS = 40;
// How long a Ctrl+C waits for the remote page to answer with its selection before the keystroke goes on
// without it. Long enough for a round trip through the tunnel, short enough not to strand the keyboard.
const SELECTION_TIMEOUT_MS = 1500;

const frame = ref<string>();
const status = ref<"connecting" | "ready" | "saving" | "error">("connecting");
const errorMsg = ref<NoticeModel>();
const viewW = ref(1280);
const viewH = ref(800);
const surface = ref<HTMLElement>();
const imgEl = ref<HTMLImageElement>();
// The address bar's text: the page's own URL, except while the user is editing it, a `url` frame landing
// mid-type would eat what they were typing.
const address = ref("");
const editingAddress = ref(false);
let socket: WebSocket | undefined;
let lastMove = 0;
// The Ctrl+C in flight, waiting on the page's answer. One at a time: a second press before the first came back
// is the same question asked twice.
let pendingSelection: ((text: string) => void) | undefined;
/* THE DROP-DOWN THE PICTURE CANNOT SHOW. Chromium draws an open <select> as a native menu outside the page, so
 * no frame ever carries it; the daemon answers a click that focused one with its options and this draws a real
 * menu over the control. Undefined whenever none is open. */
const selectMenu = ref<SelectMenu | undefined>();
// Closed here rather than on the daemon's say-so: leaving it up until a frame confirms the pick would read as
// a click that did nothing, which is the whole complaint this menu exists to answer.
const chooseOption = (index: number): void => {
    selectMenu.value = undefined;
    sendMsg({ type: "selectOption", index });
};

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

const connect = async (): Promise<void> => {
    status.value = "connecting";
    errorMsg.value = undefined;
    frame.value = undefined;
    address.value = "";
    editingAddress.value = false;
    const url = await wsSocketUrl(`/system/browser-profile`, { capability: props.capability, mode: props.mode });
    if (url === undefined) {
        status.value = "error";
        errorMsg.value = noticeOf("Sandbox isn't reachable, or you're not signed in.");
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
            url?: string;
            text?: string;
            menu?: SelectMenu | null;
        };
        // The encoding alternates: a cheap jpeg while the page paints, a sharp webp once it settles, so the
        // frame says which it is rather than the client assuming (screencast.ts).
        if (message.type === "frame" && message.data !== undefined && message.format !== undefined) {
            frame.value = `data:image/${message.format};base64,${message.data}`;
        } else if (message.type === "ready") {
            status.value = "ready";
            viewW.value = message.width ?? viewW.value;
            viewH.value = message.height ?? viewH.value;
            surface.value?.focus();
        } else if (message.type === "url" && message.url !== undefined) {
            if (!editingAddress.value) {
                address.value = message.url;
            }
        } else if (message.type === "selection") {
            pendingSelection?.(message.text ?? "");
            pendingSelection = undefined;
        } else if (message.type === "select") {
            // A drop-down to draw, or null for "nothing is open now", which closes one clicked away from.
            selectMenu.value = message.menu ?? undefined;
        } else if (message.type === "saved") {
            emit("done");
            close();
            emit("update:visible", false);
        } else if (message.type === "error") {
            status.value = "error";
            errorMsg.value = noticeOf(message.message ?? "The browser couldn't be opened.");
        }
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
onBeforeUnmount(close);

// Map a pointer event to the daemon viewport's coordinate space: viewportCoords is the shared rule, and this
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

// A PASSWORD IS PASTED, NOT TYPED, which makes this the one input a sign-in cannot do without. The Chromium
// being screencast has its own clipboard inside the sandbox and nothing on the user's machine can write to it,
// so the chord is left to the host browser (keyIntent's one deliberate exemption) and the text it hands us
// rides the same insertText path as a keystroke. Same rule in useBrowserView for the agent's browser.
const onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined || text === "") {
        return;
    }
    event.preventDefault();
    sendMsg({ type: "text", text });
};

// A typed address is a place, not a URL: "reddit.com/r/rust" is what a person writes, so assume https rather
// than handing the daemon something Chromium would refuse to navigate to.
const go = (): void => {
    const typed = address.value.trim();
    if (typed === "") {
        return;
    }
    editingAddress.value = false;
    sendMsg({ type: "go", url: /^https?:\/\//i.test(typed) ? typed : `https://${typed}` });
    surface.value?.focus();
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

        <!-- The address bar exists only while browsing: signing in goes where the platform sends it, and a URL
             field there would be a way to wander off the flow the window is open for. -->
        <div v-if="browsing" class="mb-2 flex items-center gap-1">
            <Button
                size="small"
                :text="true"
                severity="secondary"
                aria-label="Back"
                :disabled="status !== 'ready'"
                @click="sendMsg({ type: 'back' })"
            >
                <template #icon><Icon name="arrow-left" /></template>
            </Button>
            <Button
                size="small"
                :text="true"
                severity="secondary"
                aria-label="Reload"
                :disabled="status !== 'ready'"
                @click="sendMsg({ type: 'reload' })"
            >
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <input
                v-model="address"
                type="text"
                spellcheck="false"
                autocomplete="off"
                aria-label="Address"
                :disabled="status !== 'ready'"
                :class="ui.input('min-w-0 flex-1 font-mono text-xs')"
                @focus="editingAddress = true"
                @blur="editingAddress = false"
                @keydown.enter="go"
            />
            <Button size="small" :text="true" label="Go" :disabled="status !== 'ready'" @click="go" />
        </div>

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
            @paste="onPaste"
            @contextmenu.prevent
        >
            <img v-if="frame" ref="imgEl" :src="frame" alt="" draggable="false" class="h-full w-full object-contain" />
            <div v-else class="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted">
                <Icon name="spinner" spin />
                <span>{{ status === "error" ? "Couldn't start the browser." : "Starting the browser…" }}</span>
            </div>
            <!-- An open drop-down, which the picture itself can never show: see BrowserSelectMenu. -->
            <BrowserSelectMenu
                v-if="selectMenu"
                :menu="selectMenu"
                :frame="imgEl"
                :view-width="viewW"
                :view-height="viewH"
                @pick="chooseOption"
                @close="selectMenu = undefined"
            />
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
