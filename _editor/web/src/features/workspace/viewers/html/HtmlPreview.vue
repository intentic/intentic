<script setup lang="ts">
import { sizedFirst } from "@intentic/sandbox-contract";
import { EmptyState } from "@intentic/ui";
import type { IconName, Tip, TipRow } from "@intentic/ui";
import { basename } from "@intentic/ui/path";
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
// Whether a mouse is over the page, as the frame says (htmlDocument.ts): the window's own hover stops at the frame.
const pointerIn = ref(false);
watch(shown, () => {
    loads = 0;
    pointerIn.value = false;
});
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
    if (`pointer` in ask) {
        pointerIn.value = ask.pointer;
    } else if (`open` in ask) {
        emit(`open`, ask.open);
    } else {
        window.open(ask.href, `_blank`, `noopener,noreferrer`);
    }
};
// The window sees the pointer only while it is off the frame, so a move here ends a hover the frame told of, even one
// whose leave the frame was never told.
const offFrame = (): void => {
    pointerIn.value = false;
};
onMounted(() => {
    window.addEventListener(`message`, onMessage);
    window.addEventListener(`pointermove`, offFrame, { passive: true });
});
onBeforeUnmount(() => {
    window.removeEventListener(`message`, onMessage);
    window.removeEventListener(`pointermove`, offFrame);
});

const name = computed(() => basename(props.path));

// What the preview left out or put back, only when it did: a few words for the bar over the page, beside the Preview
// chip they qualify (FileViewer draws them, so no band of their own opens over the page), and the rest on hover. A file
// the page names that could not be carried is the one an author can fix, so it alone is tinted.
interface PreviewNote {
    readonly key: string;
    readonly icon: IconName;
    readonly text: string;
    // What a bar too narrow for the words shows beside the icon instead; the tip then has to say the rest alone.
    readonly count?: number;
    readonly tip: Tip;
    readonly warn: boolean;
}

// Files named on the card before the rest are counted instead, so a page with dozens missing keeps a card that fits.
const MISSING_LISTED = 6;

const missingRows = (missing: readonly string[]): { readonly rows: TipRow[]; readonly unlisted: number } => {
    const listed = missing.length <= MISSING_LISTED ? missing : missing.slice(0, MISSING_LISTED - 1);
    const rows = listed.map((file) => {
        const slash = file.lastIndexOf(`/`);
        return { label: file.slice(slash + 1), value: slash < 0 ? `/` : file.slice(0, slash) };
    });
    return { rows, unlisted: missing.length - listed.length };
};

const notes = computed((): PreviewNote[] => {
    const document = built.value;
    const lines: PreviewNote[] = [];
    if (document !== undefined && document.missing.length > 0) {
        const count = document.missing.length;
        const { rows, unlisted } = missingRows(document.missing);
        lines.push({
            key: `missing`,
            icon: `link-broken`,
            text: t(`workspace.htmlPreview.missing`, { count }, count),
            count,
            warn: true,
            tip: {
                title: t(`workspace.htmlPreview.missingTitle`),
                tone: `warning`,
                rows,
                note: unlisted > 0 ? t(`workspace.htmlPreview.missingMore`, { count: unlisted }) : t(`workspace.htmlPreview.missingWhy`),
            },
        });
    }
    if (document !== undefined && document.remote > 0) {
        lines.push({
            key: `remote`,
            icon: `globe`,
            text: t(`workspace.htmlPreview.remote`, { count: document.remote }, document.remote),
            count: document.remote,
            warn: false,
            tip: { title: t(`workspace.htmlPreview.remoteTitle`), note: t(`workspace.htmlPreview.remoteWhy`) },
        });
    }
    if (strays.value > 0) {
        lines.push(
            scripted.value
                ? {
                      key: `strayed`,
                      icon: `shield`,
                      text: t(`workspace.htmlPreview.strayed`),
                      warn: false,
                      tip: { title: t(`workspace.htmlPreview.strayed`), note: t(`workspace.htmlPreview.strayedWhy`) },
                  }
                : {
                      key: `scriptsOff`,
                      icon: `shield`,
                      text: t(`workspace.htmlPreview.scriptsOff`),
                      warn: false,
                      tip: { title: t(`workspace.htmlPreview.scriptsOff`), note: t(`workspace.htmlPreview.scriptsOffWhy`) },
                  },
        );
    }
    return lines;
});

defineExpose({ notes, pointerIn });
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <EmptyState v-if="failed" tone="danger" :title="t(`workspace.htmlPreview.failed`)" class="flex-1" />
        <div v-else-if="built === undefined" class="flex flex-1 items-center justify-center text-muted">
            <Icon name="spinner" class="text-xl" spin />
        </div>
        <!-- Keyed by the document it was handed, so a fresh frame's first load is always that document (onLoad). -->
        <iframe
            v-else
            ref="frame"
            :key="`${shown}:${scripted}`"
            :srcdoc="scripted ? sizedFirst(built.html) : built.html"
            :sandbox="scripted ? `allow-scripts` : ``"
            referrerpolicy="no-referrer"
            :title="t(`workspace.htmlPreview.title`, { name })"
            class="min-h-0 w-full flex-1 border-0 bg-white"
            @load="onLoad"
        ></iframe>
    </div>
</template>
