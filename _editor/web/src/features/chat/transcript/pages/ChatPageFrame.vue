<script setup lang="ts">
import { deliverableKindOf, type McpAppData, type Page, PAGE_MAX_HEIGHT } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { useChatSurface } from "../../tools/chatToolSurface";
import { setHtmlPreviewed } from "../../../workspace/viewers/html/htmlPreviewed";
import { sandboxRpc } from "../../../../client/sandbox/sandboxRpc";
import { initializeResult, type PageAsk, pageRefusal, pageResult, readPageAsk, themeMessage, toolInputMessage, toolResultMessage } from "./pageBridge";
import { buildPageDocument } from "./pageDocument";
import { usePageTheme } from "./pageTheme";

// One page the agent showed, drawn in the chat: its stored file, sealed (no network, an opaque origin, no reach into
// this window), wearing the chat's live theme, at the height the page says it needs. Mounted only once it nears the
// screen, so a chat full of charts costs what is on screen. Every ask the page makes comes through readPageAsk and is
// acted on here only when it is this frame's own and the reader has just pressed something in it: a page's script on
// its own can open nothing, send nothing and answer nothing.

const t = useT();

const props = defineProps<{
    page: Page;
    // What an `ask_page` page's answer does: undefined accepts it, a string is why not (the page is told). Absent on a
    // page that asks nothing, which then refuses `submit`.
    submit?: (value: string) => Promise<string | undefined>;
    // Words the page offers for the chat's composer (`intentic.send`).
    message?: (text: string) => void;
}>();

const surface = useChatSurface();
const theme = usePageTheme();

// Before the page says how tall it is: the height the sandbox measured, else a modest box.
const PLACEHOLDER = 200;
const MIN_HEIGHT = 32;
const cap = computed(() => props.page.height ?? PAGE_MAX_HEIGHT);
const reported = ref<number>();
const height = computed(() => Math.min(cap.value, Math.max(MIN_HEIGHT, reported.value ?? props.page.measured ?? PLACEHOLDER)));

const box = useTemplateRef<HTMLElement>(`box`);
const frame = useTemplateRef<HTMLIFrameElement>(`frame`);
const near = ref(false);
const srcdoc = ref<string>();
const failed = ref(false);
const loaded = ref(false);
// An MCP server's app: the call it shows, handed over once the app says it is ready (or shortly after it introduces
// itself, for an app that never says so), and only once.
let app: McpAppData | undefined;
let handedOver = false;
let handOverTimer: ReturnType<typeof setTimeout> | undefined;

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
        try {
            const built = await buildPageDocument(props.page, theme.value);
            if (current) {
                app = built.app;
                handedOver = false;
                srcdoc.value = built.html;
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
        refuse(id, error instanceof Error ? error.message : String(error));
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
            reported.value = Math.ceil(ask.height);
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
    if (ask !== undefined) {
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
    window.removeEventListener(`message`, onMessage);
    window.removeEventListener(`blur`, onWindowBlur);
    document.removeEventListener(`focusin`, noteFocus, true);
});
</script>

<template>
    <!-- The box holds the page's height from the first frame, loaded or not, so nothing below it moves when it arrives. -->
    <div ref="box" class="relative w-full" :style="{ height: `${height}px` }" :data-page="page.id">
        <iframe
            v-if="srcdoc !== undefined && !failed"
            ref="frame"
            :srcdoc="srcdoc"
            :title="page.title"
            sandbox="allow-scripts allow-forms"
            referrerpolicy="no-referrer"
            class="block size-full border-0 transition-opacity duration-150"
            :class="loaded ? `opacity-100` : `opacity-0`"
            :style="{ colorScheme: loaded ? theme.appearance : `light` }"
            @load="onLoad"
        />
        <p v-else-if="failed" class="flex size-full items-center justify-center text-2xs text-subtle">{{ t(`chat.chatPages.unavailable`) }}</p>
    </div>
</template>
