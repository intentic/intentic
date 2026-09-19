<!-- One desk tile: a glyph (or, for a picture or video, the thing itself) over a name; the quick look on hover carries the facts. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { explorerColorClass, type IconName, iconForEntry } from "@intentic/ui";
import { computed, onBeforeUnmount, onMounted, ref, type VNode, watch } from "vue";
import { stopWaiting, whenNear } from "./nearViewport";
import { thumbnailKind, thumbnailUrl } from "./thumbnails";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const {
    entry,
    selected = false,
    locked = false,
    pending = false,
    dimmed = false,
    tabindex = -1,
    renaming = false,
    dropTarget = false,
    dragging = false,
    dropDir,
    where,
} = defineProps<{
    entry: WorkspaceTreeEntry;
    // A result's folder, relative to the open one; a tile of the open folder itself has none.
    where?: string;
    selected?: boolean;
    // Kept private by the sandbox: opens its explanation, never its contents.
    locked?: boolean;
    // Still arriving (an upload in flight): drawn where it will land, inert until the listing has it.
    pending?: boolean;
    // Ignored by tooling, or a link that goes nowhere.
    dimmed?: boolean;
    // Roving: the selected tile (or the first) is the one the Tab key reaches.
    tabindex?: number;
    // The name is a field being typed into; `draft` is its text.
    renaming?: boolean;
    // A folder about to take a drop.
    dropTarget?: boolean;
    // Being dragged: drawn faint where it still stands.
    dragging?: boolean;
    // The folder a drop on this tile lands in (useEntryDrag reads it off the element); none for a locked one.
    dropDir?: string;
}>();

// The rename field's text; the owner reads it back on commit.
const draft = defineModel<string>(`draft`, { default: `` });

const emit = defineEmits<{
    select: [event: MouseEvent];
    open: [];
    enter: [el: HTMLElement];
    leave: [];
    contextmenu: [event: MouseEvent];
    commit: [];
    cancel: [];
    pointerdown: [event: PointerEvent];
    dragover: [event: DragEvent];
    dragleave: [event: DragEvent];
    drop: [event: DragEvent];
}>();

const icon = computed<IconName>(() => (locked ? `lock` : iconForEntry(entry.name, entry.type)));
// Always the colourful hue, whatever the tree's own setup: a 2rem glyph in the minimal setup's grey reads as disabled.
const color = computed(() => (locked ? `text-subtle` : explorerColorClass(`colorful`, entry.name, entry.type, dimmed)));
const quiet = computed(() => dimmed || locked || pending);

// Focus and select the name the moment the field mounts; only one is ever rendered at a time.
const focusField = (vnode: VNode): void => {
    const el = vnode.el as HTMLInputElement;
    el.focus();
    el.select();
};

// --- The thumbnail: fetched once the tile is near the viewport, never for a folder of four hundred off-screen shots. ---
const kind = computed(() => (locked || pending ? undefined : thumbnailKind(entry)));
const art = ref<HTMLElement>();
const src = ref<string>();
// Painted, so the swap from glyph to picture can fade rather than pop.
const shown = ref(false);
const failed = ref(false);
let near = false;
let retried = false;

const load = (): void => {
    if (kind.value === undefined) {
        return;
    }
    void thumbnailUrl(entry, kind.value).then(
        (url) => {
            src.value = url;
        },
        () => {
            failed.value = true;
        },
    );
};
onMounted(() => {
    if (kind.value === undefined || art.value === undefined) {
        return;
    }
    whenNear(art.value, () => {
        near = true;
        load();
    });
});
// The desk windows its tiles, so this runs whenever one scrolls out of reach, not just when the folder closes.
onBeforeUnmount(() => {
    if (art.value !== undefined) {
        stopWaiting(art.value);
    }
});
// A rewritten file (same path, new size) is a new picture.
watch(
    () => `${entry.path} ${entry.size ?? 0}`,
    () => {
        src.value = undefined;
        shown.value = false;
        failed.value = false;
        retried = false;
        if (near) {
            load();
        }
    },
);
// A URL evicted from the shared cache under a tile still on screen breaks its image; one more fetch gets a fresh one,
// and a second failure means the file itself, so the glyph stands in.
const onError = (): void => {
    src.value = undefined;
    shown.value = false;
    if (retried) {
        failed.value = true;
        return;
    }
    retried = true;
    load();
};
// A frame to show: `preload="metadata"` alone may leave the element blank until asked to seek.
const seekFrame = (event: Event): void => {
    const video = event.target as HTMLVideoElement;
    if (video.currentTime === 0) {
        video.currentTime = 0.01;
    }
};
</script>

<template>
    <!-- A div, not a button: the rename field lives inside it, and a field inside a button takes no keystrokes in Firefox.
         Moved by pointer (useEntryDrag); no native drag may start here, since one the page starts freezes the tab in Brave. -->
    <div
        role="option"
        :aria-selected="selected"
        :data-desk-tile="entry.path"
        :data-drop-dir="dropDir"
        :tabindex="tabindex"
        class="ui-row-select flex w-full flex-col items-center gap-1.5 rounded-lg px-2 pt-3 pb-2 text-center select-none"
        :class="{ 'ui-row-select-on': selected, 'ui-row-select-drop': dropTarget, 'opacity-60': pending, 'opacity-40': dragging }"
        @click="emit('select', $event)"
        @dblclick="emit('open')"
        @contextmenu="emit('contextmenu', $event)"
        @pointerdown="emit('pointerdown', $event)"
        @pointerenter="emit('enter', $event.currentTarget as HTMLElement)"
        @pointerleave="emit('leave')"
        @dragstart.prevent
        @dragover="emit('dragover', $event)"
        @dragleave="emit('dragleave', $event)"
        @drop="emit('drop', $event)"
    >
        <!-- One height for every tile, glyph or thumbnail, so names sit on one line across a row. -->
        <span ref="art" class="relative flex h-14 w-full items-center justify-center">
            <img
                v-if="kind === 'picture' && src !== undefined && !failed"
                :src="src"
                alt=""
                draggable="false"
                class="ui-desk-move max-h-14 max-w-[6.5rem] rounded-sm object-contain ring-1 ring-line/60"
                :class="shown ? 'opacity-100' : 'opacity-0'"
                @load="shown = true"
                @error="onError"
            />
            <video
                v-else-if="kind === 'video' && src !== undefined && !failed"
                :src="src"
                muted
                playsinline
                preload="metadata"
                class="ui-desk-move max-h-14 max-w-[6.5rem] rounded-sm object-contain ring-1 ring-line/60"
                :class="shown ? 'opacity-100' : 'opacity-0'"
                @loadedmetadata="seekFrame"
                @loadeddata="shown = true"
                @error="onError"
            ></video>
            <!-- The glyph holds the place until a thumbnail has painted, and stays where none can. -->
            <Icon v-if="!shown" :name="icon" class="text-[2.125rem]" :class="[color, src !== undefined && !failed ? 'absolute' : '']" />
            <!-- A link wears its target's glyph; the small mark says it is one. -->
            <Icon
                v-if="entry.link !== undefined"
                name="link"
                class="absolute right-2 bottom-0 text-[0.65rem] text-subtle"
                :aria-label="t(`workspace.deskTile.link`)"
            />
        </span>
        <!-- The field owns its keys (arrows move the caret, Enter commits, Escape cancels); none reach the desk. -->
        <input
            v-if="renaming"
            v-model="draft"
            type="text"
            :aria-label="t(`workspace.deskTile.newName`)"
            class="ui-field-box ui-field-inline h-[2.75em] w-full min-w-0 px-1 text-center text-xs"
            @click.stop
            @dblclick.stop
            @keydown.stop
            @keydown.enter.prevent="emit('commit')"
            @keydown.esc.prevent="emit('cancel')"
            @blur="emit('commit')"
            @vue:mounted="focusField"
        />
        <!-- Two lines whether the name needs them or not: the desk places its rows by arithmetic, so a tile whose height
             depended on its own name would leave the row below it in the wrong place. -->
        <span
            v-else
            class="line-clamp-2 h-[2.75em] w-full text-xs leading-snug [overflow-wrap:anywhere]"
            :class="quiet ? 'text-subtle' : 'text-content/90'"
            >{{ entry.name }}</span
        >
        <!-- Drawn whenever the desk is showing results, blank for a file in the open folder, so every tile in a search is
             the same height. -->
        <span v-if="where !== undefined" class="w-full truncate text-2xs text-subtle" :title="where">{{ where }}</span>
    </div>
</template>
