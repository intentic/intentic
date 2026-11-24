<script lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { BoundedMap } from "@intentic/base/held";
// Drawings whose errors this window already reported, and whether the agent heard: kept across mounts, so scrolling a
// page out of the chat and back neither says it twice nor forgets that it was said.
const toldPages = new Map<string, boolean>();
// The height each drawing last said it needs in the chat, kept across mounts the same way: the chat takes rows down as
// the reader leaves them and draws them again on the way back (paneWindow.ts), and a page drawn again opens at the height
// it had rather than at a guess, so nothing around it moves when it says its height again. A drawing never changes, so
// only the column's width moves it, and the page says its new height as it loads anyway.
const lastHeights = new BoundedMap<string, number>(200);
</script>

<script setup lang="ts">
import { deliverableKindOf } from "@intentic/sandbox-contract/text/documents";
import { type McpAppData, PAGE_ERRORS_MAX, sizedFirst } from "@intentic/sandbox-contract/text/pages";
import { type Page, PAGE_MAX_HEIGHT } from "@intentic/sandbox-contract/events/requests";
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, inject, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { useChatSurface } from "../../../../models/conversations/tools/chatToolSurface";
import { TRANSCRIPT_HOLD } from "../useStickToBottom";
import { setHtmlPreviewed } from "../../../../models/workspace/viewers/htmlPreviewed";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { initializeResult, type PageAsk, pageRefusal, pageResult, readPageAsk, themeMessage, toolInputMessage, toolResultMessage } from "./pageBridge";
import { buildPageDocument, mediaFailed, PAGE_BLEED } from "./pageDocument";
import { usePageTheme } from "./pageTheme";
import { usePagePictures } from "./usePagePictures";
import PictureQuickLook from "../attachments/PictureQuickLook.vue";
import PictureViewer from "../attachments/PictureViewer.vue";

// One page the agent showed, drawn in the chat: its stored file, sealed (no network, an opaque origin, no reach into
// this window), wearing the chat's live theme, at the height the page says it needs. Mounted only once it nears the
// screen, so a chat full of charts costs what is on screen. Every ask the page makes comes through readPageAsk and is
// acted on here only when it is this frame's own and the reader has just pressed something in it: a page's script on
// its own can open nothing, send nothing and answer nothing. Its pictures are looked at and opened the way a turn's own
// screenshots are (usePagePictures).

const t = useT();

const props = defineProps<{
    page: Page;
    // What an `ask_page` page's answer does: undefined accepts it, a string is why not (the page is told). Absent on a
    // page that asks nothing, which then refuses `submit`.
    submit?: (value: string) => Promise<string | undefined>;
    // Words the page offers for the chat's composer (`intentic.send`).
    message?: (text: string) => void;
    // The page alone on a screen (ChatPageScreen): the frame takes the whole of its container, and a page taller than
    // that scrolls inside it, rather than the frame fitting the page's height as it does in the chat.
    fill?: boolean;
}>();

// What the page's own scripts threw so far, and whether the agent that showed it heard.
const emit = defineEmits<{ fault: [errors: readonly string[], told: boolean] }>();

const surface = useChatSurface();
const theme = usePageTheme();

// Before the page says how tall it is: what it said when this window last drew it, else the height the sandbox measured
// (laid out without the bleed's inset above and below, so that is added), else a modest box.
const PLACEHOLDER = 200;
const MIN_HEIGHT = 32;
const cap = computed(() => props.page.height ?? PAGE_MAX_HEIGHT);
const reported = ref<number>();
const measured = computed(() => (props.page.measured === undefined ? undefined : props.page.measured + 2 * PAGE_BLEED));
const height = computed(() =>
    Math.min(cap.value, Math.max(MIN_HEIGHT, reported.value ?? lastHeights.get(props.page.path) ?? measured.value ?? PLACEHOLDER)),
);
// Keeps what the reader pressed where it stands while the page reshapes under it (useStickToBottom's hold); a frame
// drawn outside a transcript's scroller just reshapes.
const hold = inject(TRANSCRIPT_HOLD, (_element, change) => change());
// The frame reaches PAGE_BLEED past the column on either side, where the page's own inset leaves room for what it draws
// outside its edges (pageDocument.ts); above and below, that inset is part of the box's height instead, so the frame
// never lies over the words before or after it.
const bleed = { left: `-${PAGE_BLEED}px`, width: `calc(100% + ${2 * PAGE_BLEED}px)` };

const box = useTemplateRef<HTMLElement>(`box`);
const frame = useTemplateRef<HTMLIFrameElement>(`frame`);
const { shown, take, viewing, at, pictures, drawn, download } = usePagePictures(frame);
const near = ref(false);
const srcdoc = ref<string>();
const failed = ref(false);
const loaded = ref(false);
// An MCP server's app: the call it shows, handed over once the app says it is ready (or shortly after it introduces
// itself, for an app that never says so), and only once.
let app: McpAppData | undefined;
let handedOver = false;
let handOverTimer: ReturnType<typeof setTimeout> | undefined;

// What the page's scripts threw, handed to the agent that showed it while the turn that showed it runs (the daemon's
// page-errors.ts decides), once per drawing per window: a page mounted again, or drawn twice, is not said twice. The
// pause lets a page that throws in a loop say its first few together.
const errors = ref<readonly string[]>([]);
const told = ref(false);
const REPORT_AFTER_MS = 600;
let reportTimer: ReturnType<typeof setTimeout> | undefined;
const fault = (message: string): void => {
    if (errors.value.length >= PAGE_ERRORS_MAX || errors.value.includes(message)) {
        return;
    }
    errors.value = [...errors.value, message];
    told.value = toldPages.get(props.page.path) ?? false;
    emit(`fault`, errors.value, told.value);
    if (reportTimer === undefined && !toldPages.has(props.page.path) && props.page.app === undefined && props.page.superseded !== true) {
        reportTimer = setTimeout(() => void report(props.page.path), REPORT_AFTER_MS);
    }
};
const report = async (path: string): Promise<void> => {
    toldPages.set(path, false);
    try {
        const answer = await sandboxRpc.pages.reportErrors({ page: path, errors: [...errors.value] });
        toldPages.set(path, answer.told);
        if (path === props.page.path) {
            told.value = answer.told;
            emit(`fault`, errors.value, told.value);
        }
    } catch {
        // allow(silent-catch): nobody heard, which the reader's line already says by offering the ask.
    }
};

// Mounted once it comes within a screen or so, and kept: scrolling past must not reload a page someone is using.
let sight: IntersectionObserver | undefined;
onMounted(() => {
    if (typeof IntersectionObserver === `undefined` || box.value === null) {
        near.value = true;
        return;
    }
    sight = new IntersectionObserver(
        (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                near.value = true;
                sight?.disconnect();
            }
        },
        { rootMargin: `800px 0px` },
    );
    sight.observe(box.value);
});

// Built once per page, in the theme of the moment; later theme changes are posted to it rather than rebuilding it,
// which would throw away whatever the reader had done on it.
watch(
    [near, () => props.page.path],
    async ([isNear], _previous, onCleanup) => {
        if (!isNear) {
            return;
        }
        let current = true;
        onCleanup(() => {
            current = false;
        });
        failed.value = false;
        loaded.value = false;
        reported.value = undefined;
        clearTimeout(reportTimer);
        reportTimer = undefined;
        errors.value = [];
        told.value = false;
        try {
            const built = await buildPageDocument(props.page, theme.value);
            if (current) {
                app = built.app;
                handedOver = false;
                srcdoc.value = sizedFirst(built.html);
            }
        } catch {
            if (current) {
                failed.value = true;
            }
        }
    },
    { immediate: true },
);

const post = (message: unknown): void => {
    frame.value?.contentWindow?.postMessage(message, `*`);
};
watch(theme, (next) => post(themeMessage(next)));

const onLoad = (): void => {
    loaded.value = true;
    post(themeMessage(theme.value));
};

// The reader is in this frame and has just pressed something: the bar every ask with an effect has to clear.
const pressedHere = (): boolean => document.activeElement === frame.value && navigator.userActivation?.isActive !== false;

const handOver = (): void => {
    if (app === undefined || handedOver) {
        return;
    }
    handedOver = true;
    clearTimeout(handOverTimer);
    post(toolInputMessage(app.input));
    post(toolResultMessage(app.result));
};

// An app's own request of its server, carried by the sandbox; whether the reader just pressed something goes with it,
// since without a press only a tool its server marks read-only is called.
const callTool = async (id: string | number, name: string, args: Record<string, unknown>): Promise<void> => {
    if (props.page.app === undefined) {
        refuse(id, t(`chat.chatPages.notAnApp`));
        return;
    }
    try {
        const answer = await sandboxRpc.pages.appCall({ page: props.page.path, name, arguments: args, pressed: pressedHere() });
        post(pageResult(id, (answer.result ?? {}) as Record<string, unknown>));
    } catch (error) {
        refuse(id, errorMessage(error));
    }
};

// The height the page says it needs now, kept for its next drawing in this window. A page reshaping under the reader's
// own press (a tab, an accordion) is what they are reading: the chat holds it where it stands, as it does a fold they
// open, rather than following its newest line down past it.
const resized = (next: number): void => {
    if (!props.fill) {
        lastHeights.set(props.page.path, next);
    }
    if (reported.value !== undefined && next !== reported.value && pressedHere()) {
        hold(box.value, () => {
            reported.value = next;
        });
    } else {
        reported.value = next;
    }
};

const refuse = (id: string | number | undefined, why: string): void => {
    if (id !== undefined) {
        post(pageRefusal(id, why));
    }
};

const act = async (ask: PageAsk): Promise<void> => {
    switch (ask.kind) {
        case `size`:
            resized(Math.ceil(ask.height));
            return;
        case `error`:
            fault(ask.message);
            return;
        case `initialize`:
            post(pageResult(ask.id, initializeResult(theme.value, app?.tool)));
            if (app !== undefined) {
                clearTimeout(handOverTimer);
                handOverTimer = setTimeout(handOver, 800);
            }
            return;
        case `initialized`:
            handOver();
            return;
        case `toolCall`:
            await callTool(ask.id, ask.name, ask.arguments);
            return;
        case `acknowledge`:
            post(pageResult(ask.id, ask.result));
            return;
        case `openFile`:
            if (pressedHere()) {
                if (deliverableKindOf(ask.path) === `html`) {
                    setHtmlPreviewed(ask.path, true);
                }
                surface.openFile?.(ask.path);
            }
            return;
        case `openLink`:
            if (!pressedHere()) {
                refuse(ask.id, t(`chat.chatPages.needsPress`));
                return;
            }
            window.open(ask.url, `_blank`, `noopener,noreferrer`);
            if (ask.id !== undefined) {
                post(pageResult(ask.id));
            }
            return;
        case `message`:
            if (props.message === undefined || !pressedHere()) {
                refuse(ask.id, t(`chat.chatPages.needsPress`));
                return;
            }
            props.message(ask.text);
            post(pageResult(ask.id));
            return;
        case `oversize`:
            refuse(ask.id, t(`chat.chatPages.answerTooLarge`));
            return;
        case `submit`: {
            if (props.submit === undefined) {
                refuse(ask.id, t(`chat.chatPages.notAsking`));
                return;
            }
            if (!pressedHere()) {
                refuse(ask.id, t(`chat.chatPages.needsPress`));
                return;
            }
            const refusal = await props.submit(ask.value);
            post(refusal === undefined ? pageResult(ask.id) : pageRefusal(ask.id, refusal));
            return;
        }
    }
};

const onMessage = (event: MessageEvent): void => {
    if (frame.value === null || event.source !== frame.value.contentWindow) {
        return;
    }
    const ask = readPageAsk(event.data);
    // A player that failed is the window's to look into (pageDocument.ts), never an ask the page makes of the chat.
    if (ask?.kind === `mediaError`) {
        void mediaFailed(props.page.path);
    } else if (ask !== undefined && !take(ask, pressedHere)) {
        void act(ask);
    }
};

// A page's script may not take the keyboard: focus that lands in the frame without the reader's own press goes back
// where it was, so nothing typed for the composer is read by a page that grabbed it on load.
let lastFocus: HTMLElement | undefined;
const noteFocus = (event: FocusEvent): void => {
    if (event.target instanceof HTMLElement && event.target !== frame.value) {
        lastFocus = event.target;
    }
};
const onWindowBlur = (): void => {
    queueMicrotask(() => {
        if (frame.value === null || document.activeElement !== frame.value || navigator.userActivation === undefined) {
            return;
        }
        if (!navigator.userActivation.isActive) {
            frame.value.blur();
            lastFocus?.focus({ preventScroll: true });
        }
    });
};

onMounted(() => {
    window.addEventListener(`message`, onMessage);
    window.addEventListener(`blur`, onWindowBlur);
    document.addEventListener(`focusin`, noteFocus, true);
});
onBeforeUnmount(() => {
    sight?.disconnect();
    clearTimeout(handOverTimer);
    clearTimeout(reportTimer);
    window.removeEventListener(`message`, onMessage);
    window.removeEventListener(`blur`, onWindowBlur);
    document.removeEventListener(`focusin`, noteFocus, true);
});
</script>

<template>
    <!-- The box holds the page's height from the first frame, loaded or not, so nothing below it moves when it arrives. -->
    <div ref="box" class="relative w-full" :class="{ 'h-full': fill }" :style="fill ? undefined : { height: `${height}px` }" :data-page="page.id">
        <iframe
            v-if="srcdoc !== undefined && !failed"
            ref="frame"
            :srcdoc="srcdoc"
            :title="page.title"
            sandbox="allow-scripts allow-forms"
            referrerpolicy="no-referrer"
            class="absolute top-0 block h-full max-w-none border-0 transition-opacity duration-150"
            :class="loaded ? `opacity-100` : `opacity-0`"
            :style="{ ...bleed, colorScheme: loaded ? theme.appearance : `light` }"
            @load="onLoad"
        />
        <p v-else-if="failed" class="flex size-full items-center justify-center text-2xs text-subtle">{{ t(`chat.chatPages.unavailable`) }}</p>
        <PictureQuickLook :src="shown?.picture.src" :alt="shown?.picture.alt ?? ``" :box="shown?.box" />
        <!-- Mounted only while open, so a page nobody opened a picture of holds no viewer. -->
        <PictureViewer
            v-if="viewing"
            v-model:open="viewing"
            v-model:at="at"
            :pictures="pictures"
            :drawn="drawn"
            :caption="page.title"
            :filmstrip="t(`chat.chatPages.pictures`)"
        >
            <template #actions>
                <button
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`chat.pictureViewer.download`)"
                    v-tooltip.bottom="t(`chat.pictureViewer.download`)"
                    @click="download"
                >
                    <Icon name="download" class="text-xs" />
                </button>
            </template>
        </PictureViewer>
    </div>
</template>
