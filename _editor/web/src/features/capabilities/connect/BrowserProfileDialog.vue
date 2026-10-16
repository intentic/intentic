<script setup lang="ts">
import { Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useOperation } from "../../../workbench/operations/operations";
import { keyIntent, type BrowserCommand, type KeyFrame } from "../../../models/browsers/keyIntent";
import { pointerFrame, type PointerAction } from "../../../models/browsers/pointerFrame";
import { selectionCopy } from "../../../models/browsers/selectionCopy";
import { type ScreencastMessage, useScreencast } from "../../../models/browsers/useScreencast";
import { socketUrl as wsSocketUrl } from "../../../client/sandbox/streams/wsTicket";
import { useT } from "@intentic/ui/i18n";

// One connected account's Chromium, driven live over /system/browser-profile (video of the page's viewport in, input
// replayed via XTEST and CDP). `capability` picks which connection's browser to open, since a site may be connected
// more than once; `label` names the account. `login` opens sign-in; `browse` reopens the same signed-in profile. The
// socket is a live one (liveSocket.ts): pinged, and redialled after a drop, which reopens the same profile.
//
// SAVING IS THE PROFILE'S, NOT THE WINDOW'S. "I'm done" asks the daemon to flush the profile and waits for its `saved`;
// closing the window or leaving the page in that wait used to cut the socket first, so nobody learnt whether the sign-in
// was kept. The save runs in the operations ledger under the account, and holds the socket until its answer: the window
// can go, and the answer is kept (a receipt if nobody is on it), and a window opened again on the same account waits for
// it rather than opening the profile over a save still writing it.

const t = useT();

const props = defineProps<{ visible: boolean; capability: string; label: string; mode: "login" | "browse" }>();
const emit = defineEmits<{ (event: "update:visible", value: boolean): void; (event: "done"): void }>();

// Whether anything has painted yet; the picture itself lives in the canvas, not in reactive state.
const painting = ref(false);
const status = ref<"connecting" | "ready" | "saving" | "error">("connecting");
const errorMsg = ref<NoticeModel>();
// What the page shows under the pointer; the picture carries no cursor of its own.
const cursor = ref("default");
const surface = ref<HTMLElement>();
// Null, not undefined, once the dialog's content has unmounted: that is what Vue writes to a template ref.
const canvasEl = ref<HTMLCanvasElement | null>(null);
const stillEl = ref<HTMLCanvasElement | null>(null);
// Keystrokes go to the display while Chromium's find bar has them.
let rawKeys = false;
let observer: ResizeObserver | undefined;
const browsing = computed(() => props.mode === "browse");

// The screencast below, declared ahead so every verb can say something on it.
const sendMsg = (message: object): void => cast.live.send(message);
// Ctrl+C over the picture puts the page's selection on the user's own clipboard.
const copy = selectionCopy(sendMsg);

// The daemon's refusal of a save, in its own words.
class SaveRefused extends Error {
    constructor(readonly notice: NoticeModel) {
        super(notice.title);
    }
}
// The save in flight, answered by the daemon's `saved` or `error`, or by the socket dropping under it.
let answer: { readonly saved: () => void; readonly refused: (notice: NoticeModel) => void } | undefined;
// This window's content is gone: what still arrives on a socket a save holds only answers the save.
let gone = false;
const save = useOperation(() => `capabilities/${props.capability}/browser-profile`);
// What went wrong in this window, or why the last save of this profile did not go through, whichever window ran it.
const shownError = computed(() => errorMsg.value ?? save.failure.value);

// Lets the window go, and its socket with it, unless a save still holds it: that one closes it on its answer.
const close = (): void => {
    copy.cancel();
    if (answer === undefined) {
        cast.live.close();
    }
};

// The picture is on its way: a fresh `ready` also follows every resize, since that is a fresh stream, and only the
// first of a socket takes the keyboard.
const onReady = (): void => {
    const first = status.value !== "ready";
    status.value = "ready";
    errorMsg.value = undefined;
    if (first) {
        surface.value?.focus();
    }
};

const onSaved = (): void => {
    answer?.saved();
};

// Everything on this socket that isn't a picture or `ready`, kept as its own dispatch rather than inline branches.
const onMessage = (message: ScreencastMessage): void => {
    if (gone && message.type !== "saved" && message.type !== "error") {
        return;
    }
    switch (message.type) {
        case "cursor":
            cursor.value = message.cursor ?? "default";
            break;
        case "selection":
            copy.answer(message.text);
            break;
        case "saved":
            onSaved();
            break;
        case "error":
            fail(noticeOf(message.message ?? t(`capabilities.browserProfileDialog.couldntStartBrowser`)));
            break;
        default:
            break;
    }
};

// What the window says while it is not showing the picture: starting (again), or why it stopped for good.
const restart = (): void => {
    status.value = "connecting";
    painting.value = false;
};
const fail = (notice: NoticeModel): void => {
    cast.live.end();
    if (answer !== undefined) {
        answer.refused(notice);
        return;
    }
    status.value = "error";
    errorMsg.value = notice;
};

// The daemon closes with this when it refuses the window outright (a revoked ticket, an unknown account, a profile open
// elsewhere); asking again would get the same answer.
const CLOSE_REFUSED = 1008;

// The page's viewport as video, with a sharp still of the settled page over it, into the canvases connected below.
// Its socket is disposed by hand rather than with this component: a save in flight outlives the window (see above).
const cast = useScreencast({
    mint: () => wsSocketUrl(`/system/browser-profile`, { capability: props.capability, mode: props.mode }),
    pointer: pointerFrame,
    outlivesScope: true,
    // What arrives on a socket a save holds only answers the save.
    detached: () => gone,
    onMessage,
    onReady,
    onUnsupported: () => {
        status.value = "error";
        errorMsg.value = noticeOf(t(`browsers.browserView.unsupported`));
    },
    onVideoError: (message) => {
        status.value = "error";
        errorMsg.value = noticeOf(message);
    },
    onPicture: () => {
        painting.value = true;
    },
    socket: {
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
        // A window behind another tab, or hidden in the tray, need not stream; the daemon is told on every open.
        onOpen: (): void => cast.syncVisibility(),
        onDrop: (code) => {
            if (answer !== undefined) {
                // The profile may or may not have been saved; a fresh window would hide which.
                fail(noticeOf(t(`capabilities.browserProfileDialog.droppedWhileSaving`)));
            } else if (code === CLOSE_REFUSED || status.value === "error") {
                // Refused, or the daemon already said why it is giving up (`error`, then a close).
                fail(errorMsg.value ?? noticeOf(t(`capabilities.browserProfileDialog.couldntStartBrowser`)));
            } else {
                restart();
            }
        },
    },
});
const { live, video } = cast;
// Canvases mount with the dialog; the decoder outlives them, so the two are wired together here.
watch([canvasEl, stillEl], ([canvas, still]) => video.attach(canvas, still));

// The box inside the surface's border, where the canvases are, so the viewport is exactly what the modal shows
// rather than scaled into it: the border box is two pixels larger each way, which resampled every pixel of the picture.
// The modal only changes shape with the window; the screencast waits for it to hold still and asks once per size.
watch(surface, (element) => {
    observer?.disconnect();
    observer = undefined;
    if (element === undefined) {
        return;
    }
    observer = new ResizeObserver(() => cast.requestSize(element.clientWidth, element.clientHeight));
    observer.observe(element);
});

const connect = (): void => {
    restart();
    errorMsg.value = undefined;
    // A save another window left still writing this profile: waited for (below) rather than opened over.
    if (save.busy.value) {
        status.value = "saving";
        return;
    }
    save.dismiss();
    live.connect();
};

// Immediate, since an instance can mount already visible (a remount under it, an HMR replacement): waiting for a flip
// that already happened leaves a dialog open on no socket, with no picture and no way to drive it.
watch(
    () => props.visible,
    (open) => (open ? connect() : close()),
    { immediate: true },
);
// The save this window waited for, run from one before it: its end is this window's too.
watch(save.busy, (busy) => {
    if (busy || answer !== undefined || !props.visible || status.value !== "saving") {
        return;
    }
    if (save.operation.value?.state === "done") {
        emit("done");
        emit("update:visible", false);
        return;
    }
    status.value = "error";
});
onBeforeUnmount(() => {
    gone = true;
    close();
    if (answer === undefined) {
        live.dispose();
    }
    observer?.disconnect();
    // The decoder's buffers, and the size waiting to be asked, go with the component's scope (useScreencast).
});

// Every pointer event, built by the shared rule (pointerFrame) so this window and the agent's browser view describe
// drags and clicks the same way.
// The canvas is checked, not assumed: a surface whose canvas has unmounted still carries these listeners, and a null
// ref reaches viewportCoords as a dereference inside a native event handler. A canvas still hidden by `v-show` has no
// box either, and pointerFrame answers undefined rather than the origin; nothing is sent until there is a picture to
// aim at.
// Moves are throttled to one display frame (useScreencast), so a drag isn't traced at network-call granularity.
const sendPointer = (action: PointerAction, event: MouseEvent): void => {
    const canvas = canvasEl.value;
    if (canvas === null) {
        return;
    }
    const frame = cast.pointerAt(action, event, canvas);
    if (frame !== undefined) {
        sendMsg(frame);
    }
};

const onMouseMove = (event: MouseEvent): void => sendPointer("move", event);
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
const finish = async (): Promise<void> => {
    if (answer !== undefined || save.busy.value) {
        return;
    }
    if (!live.isOpen()) {
        cancel();
        return;
    }
    status.value = "saving";
    const ended = await save.run({
        what: t(`capabilities.browserProfileDialog.saving`, { label: props.label }),
        failed: (error) => (error instanceof SaveRefused ? error.notice : noticeFrom(error, t(`capabilities.browserProfileDialog.couldntSave`))),
        done: () => t(`capabilities.browserProfileDialog.saved`, { label: props.label }),
        task: async () => {
            try {
                await new Promise<void>((resolve, reject) => {
                    answer = { saved: resolve, refused: (notice) => reject(new SaveRefused(notice)) };
                    sendMsg({ type: "done" });
                });
            } finally {
                answer = undefined;
                // The socket was the save's to hold; with its answer in, nothing needs it.
                live.close();
                if (gone) {
                    live.dispose();
                }
            }
        },
    });
    if (gone) {
        return;
    }
    if (ended?.state === "done") {
        emit("done");
        emit("update:visible", false);
        return;
    }
    status.value = "error";
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
        <template #description>
            <template v-if="browsing">{{ t(`capabilities.browserProfileDialog.signedInBrowserAgent`, { label }) }}</template>
            <template v-else>
                {{ t(`capabilities.browserProfileDialog.signInWouldNormally`) }}
                <b>{{ t(`capabilities.browserProfileDialog.imDone`) }}</b> {{ t(`capabilities.browserProfileDialog.agentActHereSession`) }}
            </template>
        </template>

        <div class="flex flex-col gap-4">
            <Notice v-if="shownError" :of="shownError" />
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
        </div>

        <template #footer>
            <!-- Browsing ends by closing (the daemon flushes the profile), so one button, not a Cancel implying it's undoable. -->
            <Button v-if="browsing" :label="t(`ui.action.close`)" :loading="status === 'saving'" @click="finish">
                <template #icon><Icon name="check" /></template>
            </Button>
            <template v-else>
                <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="cancel" />
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
