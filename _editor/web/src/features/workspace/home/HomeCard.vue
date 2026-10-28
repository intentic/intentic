<!-- A file read from its start (a document, code, a stylesheet) as a card: a miniature of that start over its name, the way a file manager's grid shows a page rather than a glyph. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { explorerColorClass, formatBytes, type IconName, iconForEntry, Markdown } from "@intentic/ui";
import { focusInput } from "@intentic/ui/inline-rename";
import { useT } from "@intentic/ui/i18n";
import { fileAge } from "./homeDates";
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from "vue";
import { queueArt } from "../../../models/workspace/home/artQueue";
import { type CardPreview, cardPreview, heldPreview } from "../../../models/workspace/home/cardPreview";
import { stopWaiting, whenNear } from "../../../models/workspace/home/nearViewport";
import { provisionalAt } from "../../../models/workspace/files/provisionalEntries";
import { provisionalTooltip } from "../explorer/tree/treeRows";

const t = useT();

// The same props and events as a grid tile (HomeTile.vue says what each one means), so the home hands either the same.
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

const draft = defineModel<string>("draft", { default: `` });

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
// Its size, and its age or the line the home hands in its place (a result's folder, a time under a date heading).
const facts = computed(() =>
    [entry.size === undefined ? undefined : formatBytes(entry.size), where ?? fileAge(entry.mtime)]
        .filter((part) => part !== undefined && part !== ``)
        .join(` · `),
);

// --- The miniature: read once the card comes near the viewport, through the same queue the home's pictures wait in, so
// a fling past a folder of source files reads none of them. A card scrolled back to paints what it read before. ---------
const sheet = useTemplateRef<HTMLElement>(`sheet`);
const preview = ref<CardPreview | undefined>();
let takeBack: (() => void) | undefined;
const forget = (): void => {
    takeBack?.();
    takeBack = undefined;
    if (sheet.value !== null) {
        stopWaiting(sheet.value);
    }
};
const load = (): void => {
    forget();
    const held = heldPreview(entry);
    preview.value = held ?? undefined;
    if (held !== null || locked || pending || sheet.value === null) {
        return;
    }
    const target = entry;
    whenNear(sheet.value, () => {
        takeBack = queueArt(async () => {
            const read = await cardPreview(target);
            if (target === entry) {
                preview.value = read;
            }
        });
    });
};
watch([() => entry, () => locked, () => pending, sheet], load, { immediate: true, flush: `post` });
onBeforeUnmount(forget);
</script>

<template>
    <!-- A div, as a grid tile's is: the rename field takes keys in Firefox, and no native drag freezes the tab in Brave. -->
    <div
        role="option"
        :aria-selected="selected"
        :aria-label="entry.name"
        :data-home-tile="entry.path"
        :data-drop-dir="dropDir"
        :tabindex="tabindex"
        class="group flex min-w-0 cursor-pointer flex-col rounded-lg p-1 outline-none select-none"
        v-tooltip.bottom="pending ? provisionalTooltip(provisionalAt(entry.path)) : undefined"
        :class="{ 'ui-row-select-drop': dropTarget, 'opacity-60': pending, 'opacity-40': dragging }"
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
        <!-- The page: a fixed height, so the home places its rows by arithmetic (HomeProbe.vue). Selected, hovered and
             focused, it wears the ring a gallery picture does, round the page itself, never a card round page and name. -->
        <span
            ref="sheet"
            class="relative block h-32 overflow-hidden rounded-md bg-card outline-offset-2"
            :class="
                selected
                    ? 'outline-2 outline-(--color-selection-edge)'
                    : 'group-hover:outline-2 group-hover:outline-content/25 group-focus-visible:outline-2 group-focus-visible:outline-content/50'
            "
        >
            <!-- The start of the file at a reading size, shrunk to the page: recognised by its shape and its first words,
                 not read here. Inert, so a press lands on the card and nothing inside takes the focus. -->
            <span
                v-if="preview !== undefined"
                class="pointer-events-none absolute top-0 left-0 block h-[166.67%] w-[166.67%] origin-top-left scale-[0.6] overflow-hidden p-5 text-sm"
                aria-hidden="true"
                inert
            >
                <Markdown v-if="preview.kind === 'markdown'" :source="preview.text" />
                <!-- Code as its own lines, unwrapped, with no block of its own: the page already is one. -->
                <pre v-else class="m-0 font-mono text-xs leading-relaxed whitespace-pre text-content/80">{{ preview.text }}</pre>
            </span>
            <span v-else class="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <Icon :name="icon" class="text-[2.5rem] opacity-70" :class="color" />
            </span>
            <!-- The page runs on past its edge: a fade says so, rather than a line cut through. -->
            <span
                v-if="preview !== undefined"
                class="pointer-events-none absolute inset-x-0 bottom-0 h-12"
                style="background: linear-gradient(to top, var(--color-card), transparent)"
                aria-hidden="true"
            ></span>
            <span
                v-if="pending"
                class="pointer-events-none absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-card/85 ring-1 ring-line/60"
                aria-hidden="true"
            >
                <Icon name="spinner" :spin="true" class="text-[0.65rem] text-subtle" />
            </span>
            <Icon
                v-if="entry.link !== undefined"
                name="link"
                class="absolute top-1.5 left-1.5 rounded bg-card/85 p-0.5 text-[0.65rem] text-subtle"
                :aria-label="t(`workspace.words.symlink`)"
            />
            <span class="pointer-events-none absolute inset-0 rounded-md ring-1 ring-line/60 ring-inset" aria-hidden="true"></span>
        </span>
        <input
            v-if="renaming"
            v-model="draft"
            type="text"
            :aria-label="t(`workspace.homeTile.newName`)"
            class="ui-field-box ui-field-inline mt-2 h-5 w-full min-w-0 px-1 text-xs"
            @click.stop
            @dblclick.stop
            @keydown.stop
            @keydown.enter.prevent="emit('commit')"
            @keydown.esc.prevent="emit('cancel')"
            @blur="emit('commit')"
            @vue:mounted="focusInput"
        />
        <!-- Its kind's glyph, its name and its facts on one line, in the selection's colour while selected. -->
        <span v-else class="mt-2 flex h-5 min-w-0 items-center gap-1.5 px-1 text-xs">
            <Icon :name="icon" class="shrink-0 text-[0.8rem]" :class="color" aria-hidden="true" />
            <span
                class="min-w-0 flex-1 truncate"
                :class="selected ? 'text-(--color-selection-edge)' : quiet ? 'text-subtle' : 'text-content/90'"
                v-tooltip.bottom.overflow="entry.name"
                >{{ entry.name }}</span
            >
            <span v-if="facts" class="max-w-[50%] shrink-0 truncate text-2xs text-subtle tabular-nums">{{ facts }}</span>
        </span>
    </div>
</template>
