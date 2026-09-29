<script setup lang="ts">
import { useLatest } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { changeEpochOf } from "../../changes/live/useWorkspaceLive";
import { type AssetLoader, buildPreviewDocument, type PreviewDocument, PreviewAskSchema } from "./htmlDocument";

// A web page rendered, in a frame sealed off from this window (htmlDocument.ts has what goes in and why). The frame has
// scripts and an opaque origin: no `allow-same-origin`, so it cannot read this window, its storage or its cookies; no
// forms, popups, modals, downloads or top navigation; and the policy inside gives it no network. Drawn again when the
// page's text changes or a file it carries does.

const t = useT();

const props = defineProps<{
    path: string;
    // The page's text as the editor holds it, unsaved edits included.
    source: string;
    // Reads a file beside the page through the window's own client, in the scope the page is viewed in.
    load: AssetLoader;
}>();

// A link in the page to another workspace file.
const emit = defineEmits<{ open: [path: string] }>();

// A navigation the page made itself, away from the document it was handed: the frame is put back, and a page that keeps
// leaving loses its scripts, which are the only way it can leave without a press.
const frame = useTemplateRef<HTMLIFrameElement>(`frame`);
// Bumped for every document the frame is handed, which mounts a fresh frame; its first load is that document.
const shown = ref(0);
let loads = 0;
watch(shown, () => (loads = 0));
const strays = ref(0);
const onLoad = (): void => {
    loads += 1;
    if (loads > 1) {
        strays.value += 1;
        shown.value += 1;
    }
};
const scripted = computed(() => strays.value < 2);
// Another page, or the same page rewritten, gets its scripts back.
watch([() => props.path, () => props.source], () => (strays.value = 0));

const built = shallowRef<PreviewDocument>();
const failed = ref(false);
const latest = useLatest();

const build = (): void => {
    const isLatest = latest();
    buildPreviewDocument(props.source, props.path, props.load).then(
        (document) => {
            if (isLatest()) {
                failed.value = false;
                built.value = document;
                shown.value += 1;
            }
        },
        () => {
            if (isLatest()) {
                failed.value = true;
            }
        },
    );
};

// Every file the last build carried, by its change count: a stylesheet an agent rewrote draws the page again.
const carriedEpochs = computed(() => (built.value?.carried ?? []).map((path) => changeEpochOf(path)).join(","));
watch([() => props.path, () => props.source, carriedEpochs], build, { immediate: true });

// What the frame may ask of this window, checked to be this frame's own before anything is done: open a workspace file
// it links to, or an internet address in a new tab, which is a person's press on a link and nothing more.
const onMessage = (event: MessageEvent): void => {
    if (frame.value === null || event.source !== frame.value.contentWindow) {
        return;
    }
    const parsed = PreviewAskSchema.safeParse(event.data);
    if (!parsed.success) {
        return;
    }
    const ask = parsed.data.intenticHtmlPreview;
    if (`open` in ask) {
        emit(`open`, ask.open);
    } else {
        window.open(ask.href, `_blank`, `noopener,noreferrer`);
    }
};
onMounted(() => window.addEventListener(`message`, onMessage));
onBeforeUnmount(() => window.removeEventListener(`message`, onMessage));

const name = computed(() => props.path.slice(props.path.lastIndexOf(`/`) + 1));

// The lines over the page, only when something was left out or put back.
const notes = computed(() => {
    const document = built.value;
    const lines: { readonly text: string; readonly detail?: string }[] = [];
    if (document !== undefined && document.remote > 0) {
        lines.push({ text: t(`workspace.htmlPreview.remote`, { count: document.remote }, document.remote), detail: t(`workspace.htmlPreview.remoteWhy`) });
    }
    if (document !== undefined && document.missing.length > 0) {
        lines.push({ text: t(`workspace.htmlPreview.missing`, { count: document.missing.length }, document.missing.length), detail: document.missing.join(`\n`) });
    }
    if (strays.value > 0) {
        lines.push({ text: scripted.value ? t(`workspace.htmlPreview.strayed`) : t(`workspace.htmlPreview.scriptsOff`) });
    }
    return lines;
});
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div v-for="note in notes" :key="note.text" class="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5 text-2xs text-muted">
            <Icon name="shield" class="text-[0.7rem]" />
            <span class="flex-1" v-tooltip.bottom="note.detail">{{ note.text }}</span>
        </div>
        <div v-if="failed" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-danger" />
            <p class="text-sm text-danger">{{ t(`workspace.htmlPreview.failed`) }}</p>
        </div>
        <div v-else-if="built === undefined" class="flex flex-1 items-center justify-center text-muted">
            <Icon name="spinner" class="text-xl" spin />
        </div>
        <!-- Keyed by the document it was handed, so a fresh frame's first load is always that document (onLoad). -->
        <iframe
            v-else
            ref="frame"
            :key="`${shown}:${scripted}`"
            :srcdoc="built.html"
            :sandbox="scripted ? `allow-scripts` : ``"
            referrerpolicy="no-referrer"
            :title="t(`workspace.htmlPreview.title`, { name })"
            class="min-h-0 w-full flex-1 border-0 bg-white"
            @load="onLoad"
        ></iframe>
    </div>
</template>
