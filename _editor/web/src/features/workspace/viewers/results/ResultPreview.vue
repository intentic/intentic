<script setup lang="ts">
import { Button, EmptyState, Modal } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { extensionOf } from "@intentic/ui/file-format";
import { basename } from "@intentic/ui/path";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch, type Component } from "vue";
import { renderViewerForExtension } from "../../../../workbench/views/viewerRegistry";
import HtmlPreview from "../html/HtmlPreview.vue";
import { readResult, saveResult } from "./resultFiles";
import { printRendered } from "./printRendered";

// One of a conversation's recorded results over the page it was asked for from, read through the daemon's route that
// serves only those (resultFiles.ts), so a reader with no Files (a guest) sees it too: drawn by the viewer its kind has
// (a document's pages, a sheet, a picture), a web page in the sealed frame Files uses, with Download and Print above
// it. `printOnOpen` prints it as soon as it is drawn, for a Print pressed before the document was open.

const props = defineProps<{ conversationId: string; path: string; at?: string; printOnOpen?: boolean }>();
const open = defineModel<boolean>(`open`, { default: false });
const t = useT();
const titleId = useId();

const host = ref<HTMLElement>();
const component = shallowRef<Component>();
const content = shallowRef<{ blob: Blob } | { text: string }>();
const html = ref<string>();
const error = ref<string>();
const actionError = ref<string>();
const loading = ref(false);
// Whether the surface has drawn something to print, not just mounted: document renderers parse after mounting.
const rendered = ref(false);
const printable = computed(() => rendered.value && !loading.value && error.value === undefined && (component.value !== undefined || html.value !== undefined));
// Bumped by every load and by unmounting, so an answer for a document no longer asked for is dropped.
let generation = 0;

const print = async (): Promise<void> => {
    actionError.value = undefined;
    try {
        if (host.value !== undefined) {
            await printRendered(host.value);
        }
    } catch {
        actionError.value = t(`workspace.results.printFailed`);
    }
};

const download = async (): Promise<void> => {
    actionError.value = undefined;
    try {
        await saveResult(props.conversationId, props.path, props.at);
    } catch {
        actionError.value = t(`workspace.results.downloadFailed`);
    }
};

// A viewer that can be handed the bytes: a text or a blob one. Every kind of result has one; anything else is offered
// as a download.
const viewerFor = (path: string) => {
    const viewer = renderViewerForExtension(extensionOf(path));
    return viewer?.fetch === `text` || viewer?.fetch === `blob` ? viewer : undefined;
};

const load = async (): Promise<void> => {
    const current = ++generation;
    if (!open.value) {
        return;
    }
    rendered.value = false;
    loading.value = true;
    component.value = undefined;
    html.value = undefined;
    error.value = undefined;
    actionError.value = undefined;
    try {
        const blob = await readResult(props.conversationId, props.path, props.at);
        const page = /\.html?$/i.test(props.path);
        const viewer = page ? undefined : viewerFor(props.path);
        const loaded = await viewer?.component();
        const text = page || viewer?.fetch === `text` ? await blob.text() : undefined;
        if (current !== generation) {
            return;
        }
        html.value = page ? text : undefined;
        component.value = loaded;
        content.value = text === undefined ? { blob } : { text };
    } catch {
        if (current === generation) {
            error.value = t(`workspace.results.couldNotOpen`);
        }
    } finally {
        if (current === generation) {
            loading.value = false;
        }
    }
};
watch([open, () => props.path, () => props.conversationId], load, { immediate: true });

// What each kind's surface draws once it has its document: a Word or OpenDocument page, a slide, a sheet's table, a
// PDF, a picture, or a web page's frame that has loaded. Not just any element: a spinner is an svg too.
const DRAWN = `.docx-wrapper, .odf-page, .odf-deck > *, .pptx-frame, table, object[type="application/pdf"], img, iframe[data-print-ready]`;

// How long a drawn surface has to stay still before a Print asked for on opening goes: a document renderer lays its
// pages out in steps, and a web page's frame may be replaced once or twice as it settles.
const QUIET_MS = 400;

// Watches the surface until it has drawn: no viewer still loading or failed (ViewerStatus marks both), and something
// on the page that is the document. A Print asked for on opening goes once it has also been still a moment, once.
let stopReading: (() => void) | undefined;
watch(
    [host, loading, open],
    async () => {
        stopReading?.();
        stopReading = undefined;
        if (!open.value || loading.value || host.value === undefined) {
            return;
        }
        await nextTick();
        const target = host.value;
        const current = generation;
        let printed = false;
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const check = (): void => {
            const settled = target.querySelector(`[data-print-loading], [data-print-error]`) === null;
            rendered.value = settled && target.querySelector(DRAWN) !== null;
            clearTimeout(quiet);
            if (rendered.value && props.printOnOpen === true && !printed) {
                quiet = setTimeout(() => {
                    if (!printed && rendered.value && current === generation) {
                        printed = true;
                        void print();
                    }
                }, QUIET_MS);
            }
        };
        const observer = new MutationObserver(check);
        observer.observe(target, { childList: true, subtree: true, attributes: true });
        stopReading = () => {
            observer.disconnect();
            clearTimeout(quiet);
        };
        check();
    },
    { flush: `post` },
);
onBeforeUnmount(() => {
    generation += 1;
    stopReading?.();
});
</script>

<template>
    <Modal v-model:open="open" size="full" :chrome="false" :scroll="false" :labelled-by="titleId">
        <div class="flex min-h-0 flex-1 flex-col">
            <header class="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <h2 :id="titleId" class="min-w-0 flex-1 truncate text-sm font-medium" v-tooltip.bottom="path">{{ basename(path) }}</h2>
                <Button size="small" tier="boring" @click="download"><Icon name="download" />{{ t(`workspace.results.download`) }}</Button>
                <Button size="small" tier="boring" :disabled="!printable" @click="print"><Icon name="print" />{{ t(`workspace.results.print`) }}</Button>
                <Button size="small" tier="quiet" :aria-label="t(`workspace.results.close`)" v-tooltip.bottom="t(`workspace.results.close`)" @click="open = false">
                    <Icon name="times" />
                </Button>
            </header>
            <p v-if="actionError" role="alert" class="px-4 py-2 text-xs text-danger">{{ actionError }}</p>
            <div ref="host" class="relative min-h-0 flex-1 overflow-auto">
                <EmptyState v-if="error" :title="error" tone="danger" class="h-full" />
                <div v-else-if="loading" class="flex h-full items-center justify-center text-muted"><Icon name="spinner" class="text-xl" spin /></div>
                <!-- A page's own pictures and stylesheets are not results, so the route refuses them and the frame says so. -->
                <HtmlPreview v-else-if="html !== undefined" :path="path" :source="html" :load="(target) => readResult(conversationId, target, at)" />
                <component :is="component" v-else-if="component" :path="path" v-bind="content" @download="download" />
                <EmptyState v-else :title="t(`workspace.results.downloadToOpen`)" class="h-full" />
            </div>
        </div>
    </Modal>
</template>
