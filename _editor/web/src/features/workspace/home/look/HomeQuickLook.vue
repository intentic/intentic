<!-- The home's quick look: a card beside the hovered tile with a file's first lines, the picture itself, a document's first page, or what a folder holds. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { Code, explorerColorClass, formatBytes, formatCount, iconForEntry, SkeletonSnapshot, vSkeletonSource } from "@intentic/ui";
import { computed, type CSSProperties, nextTick, onBeforeUnmount, ref, type Ref, shallowRef, watch } from "vue";
import { useLatest } from "@intentic/ui/async";
import { useLayout } from "../../../../workbench/window/useLayout";
import { renderViewerForExtension, useViewerComponent } from "../../../../workbench/views/viewerRegistry";
import { sandboxBlob } from "../../../../client/sandbox/sandboxClient";
import { explorerShows } from "../../explorer/explorerFilter";
import { useWorkspaceTree } from "../../../../models/workspace/tree/useWorkspaceTree";
import { readFileWindow } from "../../../../models/workspace/files/fileWindow";
import { scopeQuery } from "../../../../app/workspaceScope";
import { extensionOf } from "@intentic/ui/file-format";
import { homeGroups, homeOrder } from "../homeOrder";
import { kindLabel, QUICK_LOOK_BYTES, type QuickLookKind, quickLookLines, quickLookPlan } from "../../../../models/workspace/home/quickLookContent";
import { edgeFor, screenScale } from "../../../../models/workspace/home/thumbnails";
import { mediaBox, requestBoxes } from "../../../../models/workspace/home/mediaBoxes";
import { useT } from "@intentic/ui/i18n";
import { edgeNeeded } from "../homeGallery";
import { type AnchorRect, lookFrame, mediaCard, type MediaLimits, type Size } from "./quickLookFrame";
import { useLookPicture } from "./useLookPicture";

// `entry` undefined means closed. The card takes no pointer events: it overlaps the tiles beside its anchor, and the
// pointer crossing onto one of them is how the look moves on.
const t = useT();

const { entry, anchor } = defineProps<{ entry: WorkspaceTreeEntry | undefined; anchor: HTMLElement | undefined }>();

const { listingOf, keepListed } = useWorkspaceTree();
const layout = useLayout();

const plan = computed(() => (entry === undefined ? undefined : quickLookPlan(entry)));
// The extension viewer that draws this format from bytes. Reactive: switching the viewers extension off drops the
// card back to a name and a size, the same as opening the file would.
const documentViewer = computed(() =>
    entry === undefined || plan.value?.kind !== `document` ? undefined : renderViewerForExtension(extensionOf(entry.name)),
);
// What the card actually draws: a document nothing here can paint is a document with no look, whatever the plan says.
const kind = computed<QuickLookKind>(() => {
    const planned = plan.value?.kind ?? `none`;
    return planned === `document` && documentViewer.value === undefined ? `none` : planned;
});
const icon = computed(() => (entry === undefined ? `file` : iconForEntry(entry.name, entry.type)));
const color = computed(() => (entry === undefined ? `` : explorerColorClass(`colorful`, entry.name, entry.type, entry.ignored)));

// --- Folder: what the home would show on entering it, so its count agrees with the tiles. ------------------------
const folder = (): string | undefined => (entry?.type === `dir` ? entry.path : undefined);
const folderChildren = computed(() => {
    const dir = folder();
    return dir === undefined ? undefined : listingOf(dir)?.filter((child) => explorerShows(child, layout.explorerFilters.value));
});
keepListed(folder);
// Enough names to recognise the folder by; the count says the rest.
const FOLDER_NAMES = 6;
const folderNames = computed(() => (folderChildren.value === undefined ? [] : homeOrder(homeGroups(folderChildren.value)).slice(0, FOLDER_NAMES)));

// --- File: text, a picture, a video or a document; text is read once per hover and kept for a sweep back over the same
// tiles, pictures and videos come from the cache the tiles already filled, and a document is fetched per hover, since
// no tile drew it. -----------------------------------------------------------------------------------------------
const text = ref<string>();
// A document's own bytes, handed to its viewer; shallow, since a Blob has nothing worth making reactive.
const documentBytes = shallowRef<Blob>();
const loading = ref(false);

// `documentViewer` keeps its identity per format, so moving between two documents of the same kind imports nothing.
const documentComponent = useViewerComponent(documentViewer);

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
    const window = await readFileWindow(target.path, { limit: QUICK_LOOK_BYTES, signal });
    if (!window.present || window.content.includes(`\0`)) {
        return ``; // gone, or bytes after all: nothing a glance can use
    }
    return quickLookLines(window.content, window.bytes, window.size);
};

const latest = useLatest();
let controller: AbortController | undefined;
// Lands a value only if this is still the hover that asked for it.
const settle = <T,>(isLatest: () => boolean, show: Ref<T | undefined>, value: T | undefined): void => {
    if (isLatest()) {
        show.value = value;
        loading.value = false;
    }
};
const readText = async (target: WorkspaceTreeEntry, isLatest: () => boolean, signal: AbortSignal): Promise<void> => {
    const key = cacheKey(target);
    const cached = textCache.get(key);
    if (cached !== undefined) {
        settle(isLatest, text, cached);
        return;
    }
    loading.value = true;
    try {
        const value = await fetchText(target, signal);
        rememberText(key, value);
        settle(isLatest, text, value);
    } catch {
        settle(isLatest, text, undefined); // aborted or refused: the header already says the name and kind
    }
};
// The whole file, since a document is a zip a viewer reads end to end; the look's size cap is what keeps that bounded.
const readDocument = async (target: WorkspaceTreeEntry, isLatest: () => boolean, signal: AbortSignal): Promise<void> => {
    loading.value = true;
    try {
        settle(
            isLatest,
            documentBytes,
            await sandboxBlob(`/workspace/raw?${scopeQuery(new URLSearchParams({ path: target.path })).toString()}`, { signal }),
        );
    } catch {
        settle(isLatest, documentBytes, undefined);
    }
};
const load = (target: WorkspaceTreeEntry | undefined): void => {
    controller?.abort();
    controller = undefined;
    const isLatest = latest();
    text.value = undefined;
    documentBytes.value = undefined;
    loading.value = false;
    const planned: QuickLookKind = target === undefined ? `none` : quickLookPlan(target).kind;
    if (target === undefined) {
        return;
    }
    if (planned === `text`) {
        controller = new AbortController();
        void readText(target, isLatest, controller.signal);
    } else if (planned === `picture` || planned === `video`) {
        // Its shape sizes the card; the tile that drew it has usually said it already.
        void requestBoxes([target]);
    } else if (planned === `document`) {
        controller = new AbortController();
        void readDocument(target, isLatest, controller.signal);
    }
};
watch(() => entry, load, { immediate: true });

// --- Where the card sits and how large: beside its tile on the side with the most room for it, or over the tile where
// no side has enough, always inside the window (quickLookFrame.ts). A picture's card takes the picture's shape. --------
const medium = computed(() => (kind.value === `picture` || kind.value === `video` ? kind.value : undefined));
// The card's own header and borders, around the picture: the header is one fixed height, so a card is sized before
// anything in it has drawn.
const HEADER_HEIGHT = 52;
const CHROME: Size = { width: 2, height: HEADER_HEIGHT + 3 };
// Wide enough for a text file's lines; a picture's card is no wider. A picture larger than that is Space's to show
// (HomeLightbox.vue), never a hover's.
const CARD_WIDTH = 576;
const MIN_WIDTH = 288;
const GAP = 12;
const EDGE = 8;

const box = ref<HTMLElement>();
const anchorRect = shallowRef<AnchorRect>();
const view = shallowRef<Size>();
// A card that is not a picture is as tall as what it holds, which it says once drawn.
const measured = ref(0);
// The picture's own size where known, its shape where only a smaller rendition has said it, and what the element
// reports once drawn.
const drawn = shallowRef<Size>();
const known = computed(() => (entry === undefined ? undefined : mediaBox(entry)));
const aspect = computed(() => {
    const pictureBox = known.value ?? drawn.value;
    return pictureBox === undefined || pictureBox.height <= 0 ? Number.NaN : pictureBox.width / pictureBox.height;
});
const limits = computed<MediaLimits>(() => ({
    cap: { width: CARD_WIDTH - CHROME.width, height: Math.min(384, (view.value?.height ?? 0) * 0.55) },
    own: known.value?.exact === true ? known.value : undefined,
    chrome: CHROME,
    minWidth: MIN_WIDTH,
}));
const frame = computed(() => {
    const at = anchorRect.value;
    const room = view.value;
    if (at === undefined || room === undefined) {
        return undefined;
    }
    const place = { anchor: at, view: room, gap: GAP, edge: EDGE };
    if (medium.value !== undefined) {
        return lookFrame({ ...place, size: (space) => mediaCard(space, aspect.value, limits.value) });
    }
    return lookFrame({ ...place, size: (space) => ({ width: Math.min(CARD_WIDTH, space.width), height: Math.min(measured.value, space.height), media: undefined }) });
});
// The edge the picture's box needs on this screen, as a srcset would pick it.
const pictureEdge = computed(() => {
    const media = frame.value?.media;
    if (media === undefined || media.width === 0) {
        return undefined;
    }
    const own = limits.value.own;
    return edgeFor(edgeNeeded(media.width, media.height, aspect.value, screenScale.value, own === undefined ? undefined : Math.max(own.width, own.height)));
});
const { picture, stream } = useLookPicture(
    () => entry,
    () => medium.value,
    () => pictureEdge.value,
);

// A card that is not a picture waits, unseen, until it has been measured; a picture's is sized before it draws.
const placed = computed(() => frame.value !== undefined && (medium.value !== undefined || measured.value > 0));
const style = computed<CSSProperties>(() => {
    const at = frame.value;
    if (at === undefined || !placed.value) {
        return { transform: `translate(-200vw, -200vh)`, width: `${CARD_WIDTH}px` };
    }
    const where = { left: `${Math.round(at.left)}px`, top: `${Math.round(at.top)}px`, width: `${Math.round(at.width)}px` };
    return medium.value === undefined ? { ...where, maxHeight: `${Math.round(at.height)}px` } : { ...where, height: `${Math.round(at.height)}px` };
});
const mediaStyle = computed<CSSProperties | undefined>(() => {
    const media = frame.value?.media;
    return media === undefined ? undefined : { height: `${media.height}px` };
});

const measure = (): void => {
    const doc = anchor?.ownerDocument.defaultView;
    if (anchor === undefined || doc === null || doc === undefined) {
        anchorRect.value = undefined;
        return;
    }
    const rect = anchor.getBoundingClientRect();
    anchorRect.value = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    view.value = { width: doc.innerWidth, height: doc.innerHeight };
};
let sizes: ResizeObserver | undefined;
// Vue clears a template ref to null, not undefined, when its element goes.
watch(box, (next, previous) => {
    if (previous instanceof Element) {
        sizes?.unobserve(previous);
    }
    if (next instanceof Element) {
        sizes ??= new ResizeObserver(() => {
            measured.value = box.value?.scrollHeight ?? 0;
        });
        sizes.observe(next);
    }
});
// A fresh open parks off-screen until measured; a move between tiles glides from where the card already is.
watch(
    () => anchor,
    async (next, previous) => {
        if (previous === undefined) {
            anchorRect.value = undefined;
            measured.value = 0;
        }
        drawn.value = undefined;
        await nextTick();
        measure();
    },
    { flush: `post`, immediate: true },
);
const onDrawn = (width: number, height: number): void => {
    if (width > 0 && height > 0) {
        drawn.value = { width, height };
    }
};
const onPictureDrawn = (event: Event): void => {
    // SAFETY: bound to an <img>'s load event, whose target is that element.
    const img = event.target as HTMLImageElement;
    onDrawn(img.naturalWidth, img.naturalHeight);
};
const onVideoDrawn = (event: Event): void => {
    // SAFETY: bound to a <video>'s loadedmetadata event, whose target is that element.
    const video = event.target as HTMLVideoElement;
    onDrawn(video.videoWidth, video.videoHeight);
};
// Which way the card leans in from, so its entrance comes from the tile rather than from nowhere.
const enterFrom = computed(() => (frame.value?.side === `left` ? `opacity-0 translate-x-1` : frame.value?.side === `over` ? `opacity-0` : `opacity-0 -translate-x-1`));

// A document whose bytes never came (gone, or refused): the card is its header alone, not an empty page-sized box.
const unreadable = computed(() => kind.value === `document` && !loading.value && documentBytes.value === undefined);

const size = computed(() => (entry === undefined || entry.type === `dir` ? undefined : formatBytes(entry.size)));
const count = computed(() => {
    const listed = folderChildren.value;
    return listed === undefined ? undefined : t(`workspace.homeQuickLook.itemCount`, { count: formatCount(listed.length) }, listed.length);
});

onBeforeUnmount(() => {
    controller?.abort();
    sizes?.disconnect();
});
</script>

<template>
    <Teleport to="body">
        <Transition enter-active-class="ui-home-move" :enter-from-class="enterFrom" leave-active-class="ui-home-move" leave-to-class="opacity-0">
            <div
                v-if="entry !== undefined && plan !== undefined"
                ref="box"
                class="ui-home-move pointer-events-none fixed z-[1000] flex flex-col overflow-hidden rounded-lg border border-line bg-card shadow-lg"
                :style="style"
                role="tooltip"
            >
                <!-- One height whatever it says, so a picture's card is sized before it draws. -->
                <div class="flex h-[3.25rem] shrink-0 items-center gap-2.5 px-3">
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
                     own shape, as large as its room lets (quickLookFrame.ts), and is drawn edge to edge; a folder's names
                     come from the tree on hand and take the room they need. -->
                <div
                    v-if="kind !== 'none' && !unreadable"
                    class="relative shrink-0 overflow-hidden border-t border-line bg-canvas"
                    :class="kind === 'text' ? 'h-64' : kind === 'document' ? 'h-72' : ''"
                    :style="mediaStyle"
                >
                    <template v-if="kind === 'folder'">
                        <p v-if="folderChildren !== undefined && folderChildren.length === 0" class="px-3 py-3 text-2xs text-subtle">
                            {{ t(`workspace.homeQuickLook.nothingInside`) }}
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
                                {{ t(`workspace.homeQuickLook.more`, { count: formatCount(folderChildren.length - folderNames.length) }) }}
                            </li>
                        </ul>
                    </template>
                    <template v-else-if="kind === 'picture'">
                        <img v-if="picture !== undefined" :src="picture" :alt="entry.name" class="block size-full object-contain" @load="onPictureDrawn" />
                        <Icon v-else :name="icon" class="absolute inset-0 m-auto text-[2.5rem] opacity-40" :class="color" aria-hidden="true" />
                    </template>
                    <!-- Plays silently while looked at, the way a thumbnail strip does, over the frame its tile drew; the
                         element streams by range. -->
                    <template v-else-if="kind === 'video'">
                        <video
                            v-if="stream !== undefined || picture !== undefined"
                            :src="stream"
                            :poster="picture"
                            autoplay
                            muted
                            loop
                            playsinline
                            preload="metadata"
                            class="block size-full object-contain"
                            @loadedmetadata="onVideoDrawn"
                        ></video>
                        <Icon v-else :name="icon" class="absolute inset-0 m-auto text-[2.5rem] opacity-40" :class="color" aria-hidden="true" />
                    </template>
                    <template v-else-if="text !== undefined">
                        <p v-if="text === ''" class="px-3 py-3 text-2xs text-subtle">{{ t(`workspace.homeQuickLook.nothingInYet`) }}</p>
                        <!-- The block's own frame and scrollbar are dropped: the body is already the window into the file, and a
                             card that takes no pointer can't be scrolled. -->
                        <div
                            v-else
                            v-skeleton-source="`workspace.home.quicklook`"
                            class="[&_.shiki]:overflow-hidden [&_.shiki]:rounded-none [&_.shiki]:border-0 [&_pre]:overflow-hidden [&_pre]:rounded-none [&_pre]:border-0"
                        >
                            <Code :code="text" :lang="plan.lang" :copyable="false" />
                        </div>
                    </template>
                    <!-- Reading: the last file looked at, its lines as bars, or until there is one a few line-shaped
                         placeholders, still (no animation), in the file's own measure. Above the document, so a document
                         being fetched waits behind the same lines a file being read does. Only text is remembered: every
                         hover is another file, and an empty one's note or a document's page would stand in badly for it. -->
                    <SkeletonSnapshot v-else-if="loading" of="workspace.home.quicklook">
                        <div class="flex flex-col gap-2 px-3 py-3" aria-hidden="true">
                            <div class="skeleton h-3 w-2/3"></div>
                            <div class="skeleton h-3 w-1/2"></div>
                            <div class="skeleton h-3 w-3/4"></div>
                            <div class="skeleton h-3 w-2/5"></div>
                        </div>
                    </SkeletonSnapshot>
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
