<!-- One picture of the home's gallery: the picture (or a video's frame) at the size its row gave it, over its name on one line. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { explorerColorClass, type IconName, iconForEntry } from "@intentic/ui";
import { formatDuration } from "@intentic/ui/format";
import { computed, ref } from "vue";
import { focusInput } from "@intentic/ui/inline-rename";
import { mediaBox } from "../../../models/workspace/home/mediaBoxes";
import { thumbnailKind } from "../../../models/workspace/home/thumbnails";
import { useT } from "@intentic/ui/i18n";
import { clampAspect } from "./homeGallery";
import { useTileArt } from "./useTileArt";

const t = useT();

const {
    entry,
    width,
    height,
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
    // The picture's box as its row laid it out, in pixels; the name sits under it, as wide.
    width: number;
    height: number;
    // A result's folder, or a file's time while grouped by date: said after the name, quieter.
    where?: string;
    selected?: boolean;
    locked?: boolean;
    pending?: boolean;
    dimmed?: boolean;
    tabindex?: number;
    renaming?: boolean;
    dropTarget?: boolean;
    dragging?: boolean;
    dropDir?: string;
}>();

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
const color = computed(() => (locked ? `text-subtle` : explorerColorClass(`colorful`, entry.name, entry.type, dimmed)));
const quiet = computed(() => dimmed || locked || pending);

const kind = computed(() => (locked || pending ? undefined : thumbnailKind(entry)));
const art = ref<HTMLElement>();
const { src, as, shown, failed, natural, onPicture, onVideoMetadata, onVideoFrame, onError } = useTileArt(
    () => entry,
    () => kind.value,
    `gallery`,
    art,
);

// The name cut in its middle when it does not fit, the way Finder cuts one: the start gives way and the end stays,
// since a folder of "Screenshot 2026-10-19 at 14.03.…" differs only at its end, and the extension tells a .png from
// a .gif. A short name is never split.
const KEPT_END = 6;
const nameParts = computed(() => {
    const dot = entry.name.lastIndexOf(`.`);
    const at = dot <= 0 || dot === entry.name.length - 1 ? entry.name.length : dot;
    const end = at > KEPT_END * 2 ? at - KEPT_END : at;
    return { head: entry.name.slice(0, end), tail: entry.name.slice(end, at), extension: entry.name.slice(at) };
});

// How the picture fills its box. Cropped to it where its own shape was past what a row carries (homeGallery.ts
// `clampAspect`): the top of a tall one, which is where a page or a phone screen starts, the middle of a wide one. A
// picture much smaller than its box (an icon, a favicon) is drawn at its own size rather than blown up into a blur.
const fit = computed(() => {
    const own = natural.value;
    if (own !== undefined && own.width < width * 0.75 && own.height < height * 0.75) {
        return `object-scale-down`;
    }
    const known = mediaBox(entry);
    const aspect = known === undefined ? undefined : known.width / known.height;
    if (aspect !== undefined && clampAspect(aspect) > aspect + 0.01) {
        return `object-cover object-top`;
    }
    return `object-cover`;
});

// Past a narrow picture the line after the name would leave the name a few letters; the heading above already says
// when, and the quick look says where, so the name keeps the room.
const WHERE_MIN_WIDTH = 160;
const whereShown = computed(() => (where !== undefined && where !== `` && width >= WHERE_MIN_WIDTH ? where : undefined));

// A video says it is one, and for how long, the way every player's grid does: bottom right, over the frame.
const duration = computed(() => {
    const seconds = kind.value === `video` ? mediaBox(entry)?.duration : undefined;
    return seconds === undefined ? undefined : formatDuration(seconds);
});
</script>

<template>
    <!-- The same element as a grid tile's (HomeTile.vue): a div, so the rename field takes keys in Firefox, and no native
         drag, which freezes the tab in Brave. -->
    <div
        role="option"
        :aria-selected="selected"
        :aria-label="entry.name"
        :data-home-tile="entry.path"
        :data-drop-dir="dropDir"
        :tabindex="tabindex"
        class="ui-row-select flex shrink-0 flex-col rounded-lg p-1 select-none"
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
        <!-- The box is the row's, set before anything loads, so a picture arriving never moves its neighbours. The faint
             fill behind it is what a transparent or letterboxed picture sits on. -->
        <span ref="art" class="relative block overflow-hidden rounded-md bg-content/[0.045]" :style="{ width: `${width}px`, height: `${height}px` }">
            <img
                v-if="as === 'picture' && src !== undefined && !failed"
                :src="src"
                alt=""
                draggable="false"
                decoding="async"
                class="ui-home-move absolute inset-0 size-full"
                :class="[fit, shown ? 'opacity-100' : 'opacity-0']"
                @load="onPicture"
                @error="onError"
            />
            <video
                v-else-if="as === 'video' && src !== undefined && !failed"
                :src="src"
                muted
                playsinline
                preload="metadata"
                class="ui-home-move absolute inset-0 size-full object-cover"
                :class="shown ? 'opacity-100' : 'opacity-0'"
                @loadedmetadata="onVideoMetadata"
                @seeked="onVideoFrame"
                @error="onError"
            ></video>
            <!-- The glyph holds the place until the picture has painted, and stays where there is none. -->
            <span v-if="!shown" class="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <Icon :name="icon" class="text-[2.5rem]" :class="[color, src !== undefined && !failed ? 'opacity-40' : '']" />
            </span>
            <span
                v-if="kind === 'video'"
                class="pointer-events-none absolute right-1.5 bottom-1.5 flex h-5 items-center gap-1 rounded-full bg-black/60 px-1.5 text-2xs font-medium text-white tabular-nums backdrop-blur-sm"
            >
                <Icon name="play" class="text-[0.55rem]" aria-hidden="true" />
                <span v-if="duration !== undefined">{{ duration }}</span>
                <span v-else class="sr-only">{{ t(`workspace.homeGallery.video`) }}</span>
            </span>
            <Icon
                v-if="entry.link !== undefined"
                name="link"
                class="absolute top-1.5 right-1.5 rounded bg-black/50 p-0.5 text-[0.65rem] text-white"
                :aria-label="t(`workspace.words.symlink`)"
            />
            <!-- Over the picture, not behind it, where an inset ring would be painted under it: a hairline that keeps a dark
                 picture's edge off a dark page, and the selection's ring. -->
            <span
                class="pointer-events-none absolute inset-0 rounded-md ring-inset"
                :class="selected ? 'ring-2 ring-primary-500' : 'ring-1 ring-line/50'"
                aria-hidden="true"
            ></span>
        </span>
        <input
            v-if="renaming"
            v-model="draft"
            type="text"
            :aria-label="t(`workspace.homeTile.newName`)"
            class="ui-field-box ui-field-inline mt-1 h-5 w-full min-w-0 px-1 text-xs"
            @click.stop
            @dblclick.stop
            @keydown.stop
            @keydown.enter.prevent="emit('commit')"
            @keydown.esc.prevent="emit('cancel')"
            @blur="emit('commit')"
            @vue:mounted="focusInput"
        />
        <!-- One line, one height for every picture, so the home can place its rows by arithmetic. -->
        <span v-else class="mt-1 flex h-5 min-w-0 items-center gap-2 px-0.5 text-xs" :style="{ width: `${width}px` }">
            <span class="flex min-w-0 flex-1" :class="quiet ? 'text-subtle' : 'text-content/90'">
                <span class="truncate" v-tooltip.bottom.overflow="entry.name">{{ nameParts.head }}</span>
                <span class="shrink-0 whitespace-pre">{{ nameParts.tail }}</span>
                <span class="shrink-0 text-muted">{{ nameParts.extension }}</span>
            </span>
            <span v-if="whereShown !== undefined" class="max-w-[45%] shrink-0 truncate text-2xs text-subtle" v-tooltip.bottom.overflow="whereShown">{{
                whereShown
            }}</span>
        </span>
    </div>
</template>
