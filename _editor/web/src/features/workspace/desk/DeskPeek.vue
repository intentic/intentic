<!-- The desk's quick look: a card beside the hovered tile with a file's first lines, the picture itself, a document's first page, or what a folder holds. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { Code, explorerColorClass, formatBytes, iconForEntry, placeAnchored, type Placement } from "@intentic/ui";
import { type Component, computed, type CSSProperties, nextTick, onBeforeUnmount, ref, type Ref, shallowRef, watch } from "vue";
import { useLayout } from "../../../shell/window/useLayout";
import { renderViewerForExtension } from "../../../core-views/viewerRegistry";
import { sandboxBlob } from "../../sandbox/client/sandboxClient";
import { type ExplorerFilters, explorerShows } from "../explorer/explorerFilter";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { readFileWindow } from "../files/fileWindow";
import { scopeQuery } from "../health/workspaceScope";
import { deskGroups, deskOrder, extOf } from "./deskOrder";
import { kindLabel, PEEK_BYTES, type PeekKind, peekLines, peekPlan } from "./peekContent";
import { thumbnailUrl } from "./thumbnails";
import { useT } from "@intentic/ui/i18n";

// `entry` undefined means closed. The card takes no pointer events: it overlaps the tiles beside its anchor, and the
// pointer crossing onto one of them is how the look moves on.
const t = useT();

const { entry, anchor } = defineProps<{ entry: WorkspaceTreeEntry | undefined; anchor: HTMLElement | undefined }>();

const { tree, entriesByPath, lazyChildren, loadChildren } = useWorkspaceTree();
const layout = useLayout();

const plan = computed(() => (entry === undefined ? undefined : peekPlan(entry)));
// The extension viewer that draws this format from bytes. Reactive: switching the viewers extension off drops the
// card back to a name and a size, the same as opening the file would.
const documentViewer = computed(() =>
    entry === undefined || plan.value?.kind !== `document` ? undefined : renderViewerForExtension(extOf(entry.name)),
);
// What the card actually draws: a document nothing here can paint is a document with no look, whatever the plan says.
const kind = computed<PeekKind>(() => {
    const planned = plan.value?.kind ?? `none`;
    return planned === `document` && documentViewer.value === undefined ? `none` : planned;
});
const icon = computed(() => (entry === undefined ? `file` : iconForEntry(entry.name, entry.type)));
const color = computed(() => (entry === undefined ? `` : explorerColorClass(`colorful`, entry.name, entry.type, entry.ignored)));

// --- Folder: what the desk would show on entering it, so its count agrees with the tiles. ------------------------
const filters = computed<ExplorerFilters>(() => ({
    showIgnored: layout.showIgnored.value,
    hideTests: layout.hideTests.value,
    hideTechnical: layout.hideTechnical.value,
}));
const folderChildren = computed<readonly WorkspaceTreeEntry[] | undefined>(() => {
    if (entry === undefined || entry.type !== `dir`) {
        return undefined;
    }
    const listed = entry.path === `` ? tree.value : (entriesByPath.value.get(entry.path)?.children ?? lazyChildren.value.get(entry.path));
    return listed?.filter((child) => explorerShows(child, filters.value));
});
// Enough names to recognise the folder by; the count says the rest.
const FOLDER_NAMES = 6;
const folderNames = computed(() => (folderChildren.value === undefined ? [] : deskOrder(deskGroups(folderChildren.value)).slice(0, FOLDER_NAMES)));
watch(
    () => [entry?.path, entry?.type, folderChildren.value === undefined] as const,
    ([path, type, unlisted]) => {
        if (path !== undefined && type === `dir` && unlisted) {
            void loadChildren(path);
        }
    },
    { immediate: true },
);

// --- File: text, a picture, a video or a document; text is read once per hover and kept for a sweep back over the same
// tiles, pictures and videos come from the cache the tiles already filled, and a document is fetched per hover, since
// no tile drew it. -----------------------------------------------------------------------------------------------
const text = ref<string>();
const media = ref<string>();
// A document's own bytes, handed to its viewer; shallow, since a Blob has nothing worth making reactive.
const documentBytes = shallowRef<Blob>();
const loading = ref(false);

// The viewer's component, imported on the first hover over a format and held for the rest of the session. The
// computed above keeps its identity per format, so moving between two documents of the same kind imports nothing.
const documentComponent = shallowRef<Component>();
let componentSeq = 0;
watch(
    documentViewer,
    (next) => {
        const token = ++componentSeq;
        documentComponent.value = undefined;
        if (next === undefined) {
            return;
        }
        void next.component().then((component) => {
            if (token === componentSeq) {
                documentComponent.value = component;
            }
        });
    },
    { immediate: true },
);

const TEXT_CACHE_SIZE = 32;
const textCache = new Map<string, string>();
const rememberText = (key: string, value: string): void => {
    textCache.set(key, value);
    if (textCache.size > TEXT_CACHE_SIZE) {
        const [oldest] = textCache;
        if (oldest !== undefined) {
            textCache.delete(oldest[0]);
        }
    }
};
const cacheKey = (target: WorkspaceTreeEntry): string => `${target.path} ${target.size ?? 0}`;

const fetchText = async (target: WorkspaceTreeEntry, signal: AbortSignal): Promise<string> => {
    const window = await readFileWindow(target.path, { limit: PEEK_BYTES, signal });
    if (!window.present || window.content.includes(`\0`)) {
        return ``; // gone, or bytes after all: nothing a glance can use
    }
    return peekLines(window.content, window.bytes, window.size);
};

let seq = 0;
let controller: AbortController | undefined;
// Lands a value only if this is still the hover that asked for it.
const settle = <T,>(id: number, show: Ref<T | undefined>, value: T | undefined): void => {
    if (id === seq) {
        show.value = value;
        loading.value = false;
    }
};
const readText = async (target: WorkspaceTreeEntry, id: number, signal: AbortSignal): Promise<void> => {
    const key = cacheKey(target);
    const cached = textCache.get(key);
    if (cached !== undefined) {
        settle(id, text, cached);
        return;
    }
    loading.value = true;
    try {
        const value = await fetchText(target, signal);
        rememberText(key, value);
        settle(id, text, value);
    } catch {
        settle(id, text, undefined); // aborted or refused: the header already says the name and kind
    }
};
const readMedia = async (target: WorkspaceTreeEntry, medium: "picture" | "video", id: number): Promise<void> => {
    loading.value = true;
    try {
        settle(id, media, await thumbnailUrl(target, medium));
    } catch {
        settle(id, media, undefined);
    }
};
// The whole file, since a document is a zip a viewer reads end to end; the peek's size cap is what keeps that bounded.
const readDocument = async (target: WorkspaceTreeEntry, id: number, signal: AbortSignal): Promise<void> => {
    loading.value = true;
    try {
        settle(
            id,
            documentBytes,
            await sandboxBlob(`/workspace/raw?${scopeQuery(new URLSearchParams({ path: target.path })).toString()}`, { signal }),
        );
    } catch {
        settle(id, documentBytes, undefined);
    }
};
const load = (target: WorkspaceTreeEntry | undefined): void => {
    controller?.abort();
    controller = undefined;
    const id = ++seq;
    text.value = undefined;
    media.value = undefined;
    documentBytes.value = undefined;
    loading.value = false;
    const planned: PeekKind = target === undefined ? `none` : peekPlan(target).kind;
    if (target === undefined) {
        return;
    }
    if (planned === `text`) {
        controller = new AbortController();
        void readText(target, id, controller.signal);
    } else if (planned === `picture` || planned === `video`) {
        void readMedia(target, planned, id);
    } else if (planned === `document`) {
        controller = new AbortController();
        void readDocument(target, id, controller.signal);
    }
};
watch(() => entry, load, { immediate: true });

// --- Where the card sits: beside its tile, flipping to the other side at the window's edge. -----------------------
const box = ref<HTMLElement>();
const placement = ref<Placement>();
const style = computed<CSSProperties>(() =>
    placement.value === undefined
        ? { transform: `translate(-200vw, -200vh)` }
        : { left: `${Math.round(placement.value.left)}px`, top: `${Math.round(placement.value.top)}px` },
);
const reposition = (): void => {
    const el = box.value;
    const view = anchor?.ownerDocument.defaultView;
    if (el === undefined || anchor === undefined || view === null || view === undefined) {
        return;
    }
    placement.value = placeAnchored({
        anchor: anchor.getBoundingClientRect(),
        box: el.getBoundingClientRect(),
        view: { width: view.innerWidth, height: view.innerHeight },
        side: `right`,
        cross: `start`,
        gap: 12,
        edge: 8,
    });
};
// A fresh open parks off-screen until measured; a move between tiles glides from where the card already is.
watch(
    () => anchor,
    async (next, previous) => {
        if (previous === undefined) {
            placement.value = undefined;
        }
        await nextTick();
        reposition();
    },
    { flush: `post` },
);
// Which way the card leans in from, so its entrance comes from the tile rather than from nowhere.
const enterFrom = computed(() => (placement.value?.side === `left` ? `opacity-0 translate-x-1` : `opacity-0 -translate-x-1`));

// A document whose bytes never came (gone, or refused): the card is its header alone, not an empty page-sized box.
const unreadable = computed(() => kind.value === `document` && !loading.value && documentBytes.value === undefined);

const size = computed(() => (entry === undefined || entry.type === `dir` ? undefined : formatBytes(entry.size)));
const count = computed(() => {
    const listed = folderChildren.value;
    return listed === undefined ? undefined : `${listed.length.toLocaleString()} ${listed.length === 1 ? `item` : `items`}`;
});

onBeforeUnmount(() => controller?.abort());
</script>

<template>
    <Teleport to="body">
        <Transition enter-active-class="ui-desk-move" :enter-from-class="enterFrom" leave-active-class="ui-desk-move" leave-to-class="opacity-0">
            <div
                v-if="entry !== undefined && plan !== undefined"
                ref="box"
                class="ui-desk-move pointer-events-none fixed z-[1000] w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-card shadow-lg"
                :style="style"
                role="tooltip"
            >
                <div class="flex items-center gap-2.5 px-3 py-2.5">
                    <Icon :name="icon" class="shrink-0 text-lg" :class="color" />
                    <div class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-xs font-medium text-content">{{ entry.name }}</span>
                        <span class="flex items-baseline gap-2 text-2xs text-muted">
                            <span class="truncate">{{ kindLabel(entry) }}</span>
                            <span class="ml-auto shrink-0 tabular-nums">{{ size ?? count }}</span>
                        </span>
                    </div>
                </div>
                <!-- Text and a document get a fixed body, so the card never jumps as they land. A picture or video takes its
                     own shape up to a cap the window sets, since the tile already fetched it and it lands at once; a folder's
                     names come from the tree on hand and take the room they need. -->
                <div
                    v-if="kind !== 'none' && !unreadable"
                    class="overflow-hidden border-t border-line bg-canvas"
                    :class="kind === 'text' ? 'h-64' : kind === 'document' ? 'h-72' : kind === 'folder' ? '' : 'max-h-[min(24rem,55vh)]'"
                >
                    <template v-if="kind === 'folder'">
                        <p v-if="folderChildren !== undefined && folderChildren.length === 0" class="px-3 py-3 text-2xs text-subtle">
                            {{ t(`workspace.deskPeek.nothingInside`) }}
                        </p>
                        <ul v-else-if="folderChildren !== undefined" class="flex flex-col gap-0.5 px-2 py-2">
                            <li v-for="child in folderNames" :key="child.path" class="flex items-center gap-2 truncate px-1 text-xs text-content/80">
                                <Icon
                                    :name="iconForEntry(child.name, child.type)"
                                    class="shrink-0 text-2xs"
                                    :class="explorerColorClass('colorful', child.name, child.type, child.ignored)"
                                />
                                <span class="truncate">{{ child.name }}</span>
                            </li>
                            <li v-if="folderChildren.length > folderNames.length" class="px-1 pt-1 text-2xs text-subtle">
                                {{ t(`workspace.deskPeek.more`, { count: (folderChildren.length - folderNames.length).toLocaleString() }) }}
                            </li>
                        </ul>
                    </template>
                    <template v-else-if="kind === 'picture'">
                        <img
                            v-if="media !== undefined"
                            :src="media"
                            :alt="entry.name"
                            class="block max-h-[min(24rem,55vh)] w-full object-contain p-2"
                        />
                    </template>
                    <!-- Plays silently while looked at, the way a thumbnail strip does; the element streams by range. -->
                    <template v-else-if="kind === 'video'">
                        <video
                            v-if="media !== undefined"
                            :src="media"
                            autoplay
                            muted
                            loop
                            playsinline
                            preload="metadata"
                            class="block max-h-[min(24rem,55vh)] w-full object-contain p-2"
                        ></video>
                    </template>
                    <template v-else-if="text !== undefined">
                        <p v-if="text === ''" class="px-3 py-3 text-2xs text-subtle">{{ t(`workspace.deskPeek.nothingInYet`) }}</p>
                        <!-- The block's own frame and scrollbar are dropped: the body is already the window into the file, and a
                             card that takes no pointer can't be scrolled. -->
                        <div
                            v-else
                            class="[&_.shiki]:overflow-hidden [&_.shiki]:rounded-none [&_.shiki]:border-0 [&_pre]:overflow-hidden [&_pre]:rounded-none [&_pre]:border-0"
                        >
                            <Code :code="text" :lang="plan.lang" :copyable="false" />
                        </div>
                    </template>
                    <!-- Reading: a few line-shaped placeholders, still (no animation), in the file's own measure. Above the
                         document, so a document being fetched waits behind the same lines a file being read does. -->
                    <div v-else-if="loading" class="flex flex-col gap-2 px-3 py-3" aria-hidden="true">
                        <div class="skeleton h-3 w-2/3"></div>
                        <div class="skeleton h-3 w-1/2"></div>
                        <div class="skeleton h-3 w-3/4"></div>
                        <div class="skeleton h-3 w-2/5"></div>
                    </div>
                    <!-- The file's own pages, drawn by the extension that owns the format, at the scale a thumbnail reads at:
                         the top of the first page is all a glance gets, since a card that takes no pointer can't be scrolled. -->
                    <div
                        v-else-if="kind === 'document' && documentComponent && documentBytes"
                        class="h-full w-full [zoom:0.7] [&_*]:[scrollbar-width:none]"
                    >
                        <component :is="documentComponent" :blob="documentBytes" />
                    </div>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>
