<!-- One home tile: a glyph (or, for a picture or video, the thing itself) over a name; the quick look on hover carries the facts. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { explorerColorClass, type IconName, iconForEntry } from "@intentic/ui";
import { computed, ref } from "vue";
import { focusInput } from "@intentic/ui/inline-rename";
import { thumbnailKind } from "../../../models/workspace/home/thumbnails";
import { useTileArt } from "./useTileArt";
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

// --- The thumbnail: fetched once the tile is near the viewport, never for a folder of four hundred off-screen shots. ---
const kind = computed(() => (locked || pending ? undefined : thumbnailKind(entry)));
const art = ref<HTMLElement>();
const { src, as, shown, failed, onPicture, onVideoMetadata, onVideoFrame, onError } = useTileArt(
    () => entry,
    () => kind.value,
    `tile`,
    art,
);
</script>

<template>
    <!-- A div, not a button: the rename field lives inside it, and a field inside a button takes no keystrokes in Firefox.
         Moved by pointer (useEntryDrag); no native drag may start here, since one the page starts freezes the tab in Brave. -->
    <div
        role="option"
        :aria-selected="selected"
        :data-home-tile="entry.path"
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
            <!-- A video's frame is a picture too, cut by the daemon; only a sandbox without ffmpeg hands over the video. -->
            <img
                v-if="as === 'picture' && src !== undefined && !failed"
                :src="src"
                alt=""
                draggable="false"
                class="ui-home-move max-h-14 max-w-[6.5rem] rounded-sm object-contain ring-1 ring-line/60"
                :class="shown ? 'opacity-100' : 'opacity-0'"
                @load="onPicture"
                @error="onError"
            />
            <video
                v-else-if="as === 'video' && src !== undefined && !failed"
                :src="src"
                muted
                playsinline
                preload="metadata"
                class="ui-home-move max-h-14 max-w-[6.5rem] rounded-sm object-contain ring-1 ring-line/60"
                :class="shown ? 'opacity-100' : 'opacity-0'"
                @loadedmetadata="onVideoMetadata"
                @seeked="onVideoFrame"
                @error="onError"
            ></video>
            <!-- Says a picture is a video before the quick look plays it. -->
            <span v-if="kind === 'video' && shown" class="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <span class="flex size-5 items-center justify-center rounded-full bg-black/55 text-[0.55rem] text-white ring-1 ring-white/25">
                    <Icon name="play" class="translate-x-px" />
                </span>
            </span>
            <!-- The glyph holds the place until a thumbnail has painted, and stays where none can. -->
            <Icon v-if="!shown" :name="icon" class="text-[2.125rem]" :class="[color, src !== undefined && !failed ? 'absolute' : '']" />
            <!-- A link wears its target's glyph; the small mark says it is one. -->
            <Icon
                v-if="entry.link !== undefined"
                name="link"
                class="absolute right-2 bottom-0 text-[0.65rem] text-subtle"
                :aria-label="t(`workspace.words.symlink`)"
            />
        </span>
        <!-- The field owns its keys (arrows move the caret, Enter commits, Escape cancels); none reach the home. -->
        <input
            v-if="renaming"
            v-model="draft"
            type="text"
            :aria-label="t(`workspace.homeTile.newName`)"
            class="ui-field-box ui-field-inline h-[2.75em] w-full min-w-0 px-1 text-center text-xs"
            @click.stop
            @dblclick.stop
            @keydown.stop
            @keydown.enter.prevent="emit('commit')"
            @keydown.esc.prevent="emit('cancel')"
            @blur="emit('commit')"
            @vue:mounted="focusInput"
        />
        <!-- Two lines whether the name needs them or not, and the line under it (a result's place, a file's date) shares
             them rather than adding a third: the home places its rows by arithmetic, so a tile whose height depended on
             its name or its mode would leave the row below it in the wrong place, and Date would space rows wider than Kind. -->
        <span v-else class="flex h-[2.75em] w-full flex-col text-xs leading-snug">
            <span
                class="w-full [overflow-wrap:anywhere]"
                :class="[quiet ? 'text-subtle' : 'text-content/90', where ? 'line-clamp-1' : 'line-clamp-2']"
                v-tooltip.bottom.overflow="where ? entry.name : undefined"
                >{{ entry.name }}</span
            >
            <span v-if="where" class="w-full truncate text-2xs text-subtle" v-tooltip.bottom.overflow="where">{{ where }}</span>
        </span>
    </div>
</template>
