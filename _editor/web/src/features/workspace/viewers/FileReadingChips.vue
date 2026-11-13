<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type HtmlPreview from "../../../parts/workspace/HtmlPreview.vue";
import { setHtmlPreviewed } from "../../../models/workspace/viewers/htmlPreviewed";
import { useLayout } from "../../../workbench/window/useLayout";

/* The ways to read the open file another way, in its bar (FileViewer): comments hidden, its derived text, a web page
   rendered, and what that rendering left out. Each shows only where FileViewer offers it. */

const { path, comments, derived, preview, previewing, notes } = defineProps<{
    path: string;
    comments: boolean;
    derived: boolean;
    preview: boolean;
    previewing: boolean;
    notes: InstanceType<typeof HtmlPreview>[`notes`];
}>();
const textWanted = defineModel<boolean>("textWanted", { required: true });

const t = useT();
const { hideFileComments, toggleHideFileComments } = useLayout();
</script>

<template>
    <!-- The three reading toggles are glyphs alone in the pane's tab bar, which tabs and a document's own toolbar already
         crowd, their names in the tooltip; on a phone's viewer bar they keep their words, since it has the width to itself. -->
    <!-- Same Comments toggle as the diff surface, one habit across both; starts shown here, since opening a file asks what it says. -->
    <button
        v-if="comments"
        type="button"
        :class="ui.chip({ on: hideFileComments, size: `sm` }, `shrink-0 font-medium`)"
        :aria-pressed="hideFileComments"
        @click="toggleHideFileComments()"
        v-tooltip.bottom="hideFileComments ? t(`workspace.fileViewer.showComments`) : t(`workspace.fileViewer.hideComments`)"
    >
        <Icon :name="hideFileComments ? 'eye-slash' : 'eye'" class="text-2xs" />
        <span class="in-[.view-header]:sr-only">{{ t(`workspace.words.comments`) }}</span>
    </button>
    <!-- Second reading of the same file, one click away: what a pdf, a spreadsheet or a picture becomes as text. -->
    <button
        v-if="derived"
        type="button"
        :class="ui.chip({ on: textWanted, size: `sm` }, `shrink-0 font-medium`)"
        :aria-pressed="textWanted"
        @click="textWanted = !textWanted"
        v-tooltip.bottom="
            textWanted
                ? t(`workspace.fileViewer.showFile`)
                : { title: t(`workspace.fileViewer.readAsText`), note: t(`workspace.words.whatAgentsRead`) }
        "
    >
        <Icon :name="textWanted ? 'file' : 'align-left'" class="text-2xs" />
        <span class="in-[.view-header]:sr-only">{{ t(`workspace.words.text`) }}</span>
    </button>
    <!-- A web page's rendered view and its source, one press apart, like the Text chip above. -->
    <button
        v-if="preview"
        type="button"
        :class="ui.chip({ on: previewing, size: `sm` }, `shrink-0 font-medium`)"
        :aria-pressed="previewing"
        @click="setHtmlPreviewed(path, !previewing)"
        v-tooltip.bottom="
            previewing
                ? t(`workspace.fileViewer.showSource`)
                : { title: t(`workspace.fileViewer.showPage`), note: t(`workspace.fileViewer.pageSandboxed`) }
        "
    >
        <Icon :name="previewing ? 'code' : 'eye'" class="text-2xs" />
        <span class="in-[.view-header]:sr-only">{{ t(`workspace.fileViewer.preview`) }}</span>
    </button>
    <!-- What that preview left out or put back, in a few words beside the chip they qualify; the detail is on hover
         or focus. A bar too narrow for the words (the tab row of a narrow pane, a slim band) keeps the icon and the
         count, the words left for a screen reader; truncation is only the last resort below that. -->
    <span
        v-for="note in notes"
        :key="note.key"
        tabindex="0"
        class="inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs"
        :class="note.warn ? `text-warning` : `text-muted`"
        v-tooltip.bottom="note.tip"
    >
        <Icon :name="note.icon" class="shrink-0 text-[0.7rem]" />
        <span class="truncate @max-4xl/tabbar:sr-only @max-sm/viewerbar:sr-only">{{ note.text }}</span>
        <span
            v-if="note.count !== undefined"
            aria-hidden="true"
            class="hidden tabular-nums @max-4xl/tabbar:inline @max-sm/viewerbar:inline"
            >{{ note.count }}</span
        >
    </span>
</template>
