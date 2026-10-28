<!-- A folder above a gallery: its glyph and its name on one line, a chip in a grid of chips, so the pictures under it have the screen. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { explorerColorClass, type IconName, iconForEntry } from "@intentic/ui";
import { computed } from "vue";
import { focusInput } from "@intentic/ui/inline-rename";
import { useT } from "@intentic/ui/i18n";
import { provisionalAt } from "../../../../models/workspace/files/provisionalEntries";
import { provisionalTooltip } from "../../explorer/tree/treeRows";

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
// A chip stands on a faint fill of its own at rest, so a strip of them reads as places to go rather than loose words.
// The selected tint and a drop's fill are the row's own (`ui-row-select-*`), which a fill set here would paint over.
const resting = computed(() => !selected && !dropTarget);
</script>

<template>
    <!-- A div, as a grid tile's is: the rename field takes keys in Firefox, and no native drag freezes the tab in Brave.
         Selection is the tint and the name in the selection's colour, as a selected picture's caption wears it, never the
         left edge a skin draws to mark a row in a column of rows, which a chip is not. -->
    <div
        role="option"
        :aria-selected="selected"
        :aria-label="entry.name"
        :data-home-tile="entry.path"
        :data-drop-dir="dropDir"
        :tabindex="tabindex"
        class="ui-row-select ui-row-select-horizontal flex h-9 min-w-0 items-center gap-2 rounded-lg px-2.5 text-xs select-none"
        v-tooltip.bottom="pending ? provisionalTooltip(provisionalAt(entry.path)) : undefined"
        :class="{
            'ui-row-select-on': selected,
            'ui-row-select-drop': dropTarget,
            'bg-content/[0.045] hover:bg-content/[0.08]': resting,
            'opacity-60': pending,
            'opacity-40': dragging,
        }"
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
        <Icon :name="pending ? 'spinner' : icon" :spin="pending" class="shrink-0 text-sm" :class="pending ? 'text-subtle' : color" aria-hidden="true" />
        <input
            v-if="renaming"
            v-model="draft"
            type="text"
            :aria-label="t(`workspace.homeTile.newName`)"
            class="ui-field-box ui-field-inline h-6 min-w-0 flex-1 px-1 text-xs"
            @click.stop
            @dblclick.stop
            @keydown.stop
            @keydown.enter.prevent="emit('commit')"
            @keydown.esc.prevent="emit('cancel')"
            @blur="emit('commit')"
            @vue:mounted="focusInput"
        />
        <span
            v-else
            class="min-w-0 flex-1 truncate"
            :class="selected ? 'text-(--color-selection-edge)' : quiet ? 'text-subtle' : 'text-content/90'"
            v-tooltip.bottom.overflow="entry.name"
            >{{ entry.name }}</span
        >
        <Icon v-if="entry.link !== undefined" name="link" class="shrink-0 text-[0.65rem] text-subtle" :aria-label="t(`workspace.words.symlink`)" />
        <span v-if="where" class="max-w-[45%] shrink-0 truncate text-2xs text-subtle" v-tooltip.bottom.overflow="where">{{ where }}</span>
    </div>
</template>
