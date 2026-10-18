<script setup lang="ts">
import { PreviewGuideSayingSchema } from "@intentic/sandbox-contract/text/preview-guide";
import { EmptyState } from "@intentic/ui";
import type { IconName, Tip, TipRow } from "@intentic/ui";
import { basename } from "@intentic/ui/path";
import { useLatest } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from "vue";
import { useViewScope } from "../../app/workspaceScope";
import { changeEpochOf } from "../../models/workspace/changes/useWorkspaceLive";
import { type AssetLoader, buildPreviewDocument, type PreviewDocument, PreviewAskSchema } from "../../models/workspace/viewers/htmlDocument";
import {
    canServePreview,
    mintPreview,
    type PreviewAddress,
    SERVED_FRAME_SANDBOX,
    workspacePathIn,
} from "../../models/workspace/viewers/servedPreview";
import { recordPrintSource } from "./printRendered";

// A web page rendered in a frame sealed off from this window, its scripts always running. Where the daemon can serve it
// (servedPreview.ts), the frame loads it from the daemon's address for it and the page runs as it would on a static
// file server: modules, fetches, workers, the internet, links between its pages, all in an opaque origin that reaches
// neither this window nor the daemon's API. Where it cannot, the page is one sealed document (htmlDocument.ts), its
// files carried inside and no network. Either way it is drawn again when its text changes or a file it loaded does.

const t = useT();

const props = defineProps<{
    path: string;
    // The page's text as the editor holds it, unsaved edits included.
    source: string;
    // Whether `source` holds edits not yet saved, which the served page then shows in place of the file.
    unsaved?: boolean;
    // Reads a file beside the page through the window's own client, in the scope the page is viewed in (sealed only).
    load: AssetLoader;
}>();

// A link in the sealed page to another workspace file.
const emit = defineEmits<{ open: [path: string] }>();

const viewAgent = useViewScope();
// A daemon that advertises nothing reads as able to mint; one whose mint then fails is previewed sealed instead.
const mintRefused = ref(false);
const served = computed(() => canServePreview() && !mintRefused.value);

const frame = useTemplateRef<HTMLIFrameElement>(`frame`);
const host = useTemplateRef<HTMLDivElement>(`host`);
// Whether a mouse is over the page, as the frame says: the window's own hover stops at the frame.
const pointerIn = ref(false);
const failed = ref(false);
const latest = useLatest();

// SERVED: the address the frame loads, and the files the page told of, each with the change count it had when told,
// so one rewritten since draws the page again. Missing ones are named in the bar.
const address = shallowRef<PreviewAddress>();
const reloads = ref(0);
const loaded = shallowRef<ReadonlyMap<string, number>>(new Map());
const missing = shallowRef<readonly string[]>([]);

const mint = (): void => {
    const isLatest = latest();
    mintPreview(props.path, { agent: viewAgent.value }, props.unsaved === true ? props.source : undefined).then(
        (minted) => {
            if (isLatest()) {
                failed.value = false;
                address.value = minted;
            }
        },
        () => {
            if (isLatest()) {
                mintRefused.value = true;
            }
        },
    );
};

// A fresh frame tells its files afresh.
watch([address, reloads], () => {
    loaded.value = new Map();
    missing.value = [];
    pointerIn.value = false;
});
// The page's own file is left to its text, which mints a fresh address when it changes.
const stale = computed(() => [...loaded.value].some(([path, epoch]) => path !== props.path && changeEpochOf(path) !== epoch));
watch(stale, (now) => {
    if (now) {
        reloads.value += 1;
    }
});

// SEALED: the page as one document, its frame mounted only once it has a width (a page that measures itself at load
// would otherwise draw at none), and a navigation the page made away from it put back, a few times, then left.
const built = shallowRef<PreviewDocument>();
const shown = ref(0);
const strays = ref(0);
const STRAYS_PUT_BACK = 3;
let loads = 0;
const sized = ref(false);
let observer: ResizeObserver | undefined;
watch(shown, () => {
    loads = 0;
    pointerIn.value = false;
});
watch([() => props.path, () => props.source], () => (strays.value = 0));

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
// Every file the last sealed build carried, by its change count: a stylesheet an agent rewrote draws the page again.
const carriedEpochs = computed(() => (built.value?.carried ?? []).map((path) => changeEpochOf(path)).join(","));

watch(
    [() => props.path, () => props.source, () => props.unsaved, viewAgent, served, carriedEpochs],
    () => {
        if (served.value) {
            mint();
        } else {
            build();
        }
    },
    { immediate: true },
);

const onLoad = (event: Event): void => {
    // A frame already replaced by the next one can still report a load as it goes.
    if (event.target !== frame.value || frame.value === null) {
        return;
    }
    // What a print waits for before it asks the page what it shows, and what it prints if the page cannot answer.
    frame.value.dataset[`printReady`] = `true`;
    recordPrintSource(frame.value, served.value ? props.source : (built.value?.html ?? props.source));
    if (served.value) {
        return;
    }
    loads += 1;
    if (loads > 1) {
        strays.value += 1;
        if (strays.value <= STRAYS_PUT_BACK) {
            shown.value += 1;
        }
    }
};

const onMessage = (event: MessageEvent): void => {
    if (frame.value === null || event.source !== frame.value.contentWindow) {
        return;
    }
    if (served.value) {
        const told = PreviewGuideSayingSchema.safeParse(event.data);
        const root = address.value?.root;
        if (!told.success || root === undefined) {
            return;
        }
        const saying = told.data.intenticHtmlPreview;
        if (`pointer` in saying) {
            pointerIn.value = saying.pointer;
        } else if (`href` in saying) {
            window.open(saying.href, `_blank`, `noopener,noreferrer`);
        } else if (`loaded` in saying) {
            const next = new Map(loaded.value);
            for (const path of saying.loaded) {
                const workspacePath = workspacePathIn(root, path);
                next.set(workspacePath, changeEpochOf(workspacePath));
            }
            loaded.value = next;
        } else if (!missing.value.includes(workspacePathIn(root, saying.missing))) {
            missing.value = [...missing.value, workspacePathIn(root, saying.missing)];
        }
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
// The window sees the pointer only while it is off the frame, so a move here ends a hover the frame told of.
const offFrame = (): void => {
    pointerIn.value = false;
};
onMounted(() => {
    window.addEventListener(`message`, onMessage);
    window.addEventListener(`pointermove`, offFrame, { passive: true });
    observer = new ResizeObserver(([entry]) => {
        if ((entry?.contentRect.width ?? 0) > 0) {
            sized.value = true;
        }
    });
    if (host.value !== null) {
        observer.observe(host.value);
    }
});
onBeforeUnmount(() => {
    window.removeEventListener(`message`, onMessage);
    window.removeEventListener(`pointermove`, offFrame);
    observer?.disconnect();
});

const name = computed(() => basename(props.path));

// What the preview could not load or left out, only when it did: a few words for the bar over the page, beside the
// Preview chip they qualify (FileViewer draws them), and the rest on hover. A file the page names that is not there is
// the one an author can fix, so it alone is tinted.
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

const missingRows = (files: readonly string[]): { readonly rows: TipRow[]; readonly unlisted: number } => {
    const listed = files.length <= MISSING_LISTED ? files : files.slice(0, MISSING_LISTED - 1);
    const rows = listed.map((file) => {
        const slash = file.lastIndexOf(`/`);
        return { label: file.slice(slash + 1), value: slash < 0 ? `/` : file.slice(0, slash) };
    });
    return { rows, unlisted: files.length - listed.length };
};

const missingNote = (files: readonly string[]): PreviewNote => {
    const count = files.length;
    const { rows, unlisted } = missingRows(files);
    return {
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
    };
};

const notes = computed((): PreviewNote[] => {
    if (served.value) {
        return missing.value.length > 0 ? [missingNote(missing.value)] : [];
    }
    const document = built.value;
    const lines: PreviewNote[] = [];
    if (document !== undefined && document.missing.length > 0) {
        lines.push(missingNote(document.missing));
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
        lines.push({
            key: `strayed`,
            icon: `shield`,
            text: t(`workspace.htmlPreview.strayed`),
            warn: false,
            tip: { title: t(`workspace.htmlPreview.strayed`), note: t(`workspace.htmlPreview.strayedWhy`) },
        });
    }
    return lines;
});

defineExpose({ notes, pointerIn });
</script>

<template>
    <div ref="host" class="flex h-full min-h-0 flex-col">
        <!-- Marked the way a viewer's own status is (ViewerStatus), so a print waits for the page rather than this. -->
        <EmptyState v-if="failed" data-print-error="true" tone="danger" :title="t(`workspace.htmlPreview.failed`)" class="flex-1" />
        <!-- Keyed by the address and each redraw, so a page whose files changed loads afresh. -->
        <iframe
            v-else-if="served && address !== undefined"
            ref="frame"
            :key="`${address.url}#${reloads}`"
            :src="address.url"
            :sandbox="SERVED_FRAME_SANDBOX"
            allow="fullscreen; clipboard-read; clipboard-write; autoplay; encrypted-media; picture-in-picture"
            allowfullscreen
            referrerpolicy="no-referrer"
            data-print-page="true"
            :title="t(`workspace.htmlPreview.title`, { name })"
            class="min-h-0 w-full flex-1 border-0 bg-white"
            @load="onLoad"
        ></iframe>
        <!-- Keyed by the document it was handed, so a fresh frame's first load is always that document (onLoad). -->
        <iframe
            v-else-if="!served && built !== undefined && sized"
            ref="frame"
            :key="shown"
            :srcdoc="built.html"
            sandbox="allow-scripts"
            referrerpolicy="no-referrer"
            data-print-page="true"
            :title="t(`workspace.htmlPreview.title`, { name })"
            class="min-h-0 w-full flex-1 border-0 bg-white"
            @load="onLoad"
        ></iframe>
        <div v-else data-print-loading="true" class="flex flex-1 items-center justify-center text-muted">
            <Icon name="spinner" class="text-xl" spin />
        </div>
    </div>
</template>
