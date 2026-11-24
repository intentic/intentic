<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { computed } from "vue";
import { useLayout } from "../../../workbench/window/useLayout";
import { useT } from "@intentic/ui/i18n";

// Outline of a diff whose content hasn't arrived: what a `pending` tab shows until that file's diff has been seen once
// (its `diff:${path}` imprint stands in after that). Drawn as the eventual layout, not a spinner, since the reader
// already knows which file; the toolbar above already gives status and ± counts. Split follows the same preference the
// real viewer reads, so the outline never promises a layout the diff then contradicts. `single` is a file's own text
// on its way (FileViewer), which has one side whatever that preference says.

const t = useT();

const { bare = false, single = false } = defineProps<{
    /** Omit the status region when the caller already announces the review wait. */
    bare?: boolean;
    /** One pane whatever the diff layout: a file's text, not a diff of it. */
    single?: boolean;
}>();

const { mobile } = useDevice();
const { diffLayout } = useLayout();
const split = computed(() => !single && !mobile.value && diffLayout.value === `split`);

// Fixed, uneven lines of a typical source file, in the editor's own rhythm: an import block, a gap, a comment, then a
// declaration with an indented body. Widths are in characters' worth of width and indents in levels, so the outline
// reads as code at the editor's size rather than as a column of bars; blank lines are kept, as the file's own gaps.
// Repeated to a screen's worth; the pane clips the rest.
const BLOCK = [
    { width: `w-64`, level: 0 },
    { width: `w-72`, level: 0 },
    { width: `w-56`, level: 0 },
    { width: ``, level: 0 },
    { width: `w-96`, level: 0 },
    { width: `w-80`, level: 0 },
    { width: ``, level: 0 },
    { width: `w-96`, level: 0 },
    { width: `w-72`, level: 1 },
    { width: `w-40`, level: 1 },
    { width: `w-64`, level: 2 },
    { width: `w-80`, level: 2 },
    { width: `w-20`, level: 1 },
    { width: ``, level: 0 },
    { width: `w-28`, level: 1 },
    { width: `w-56`, level: 2 },
    { width: `w-72`, level: 3 },
    { width: `w-48`, level: 3 },
    { width: `w-32`, level: 2 },
    { width: `w-8`, level: 1 },
    { width: `w-4`, level: 0 },
    { width: ``, level: 0 },
] as const;
const LINES = [...BLOCK, ...BLOCK];
// An indent level is four spaces of the editor's monospace.
const INDENT = [``, `ml-8`, `ml-16`, `ml-24`] as const;
</script>

<template>
    <!-- The bars are decoration; role=status plus the sr-only line carry it to the readers who need it said. -->
    <!-- A size container: the diff falls back to one pane where its pane is under DiffView's SPLIT_MIN_REM, and so does
         this, by the same width, with no observer of its own. -->
    <div class="@container flex h-full min-h-0 overflow-hidden" :role="bare ? undefined : `status`" :aria-busy="bare ? undefined : true">
        <span v-if="!bare" class="sr-only">{{ t(`workspace.diffSkeleton.readingFile`) }}</span>
        <!-- The editors' geometry (useMonaco's TYPE_PX): a file's 20px line, its first one in from the top, and a gutter whose
             numbers end short of the folding column; a diff's tighter 17px line from the top, with the old and new
             numbers side by side when both sides share one pane. -->
        <div
            v-for="pane in split ? 2 : 1"
            :key="pane"
            class="min-w-0 flex-1 flex-col overflow-hidden border-line not-first:border-l"
            :class="[single ? `pt-3` : ``, pane === 2 ? `hidden @min-[44rem]:flex` : `flex`]"
            aria-hidden="true"
        >
            <!-- allow(tailwind): the diff editor's line is Monaco's own 17px (useMonaco's TYPE_PX), off the spacing scale. -->
            <span v-for="(line, index) in LINES" :key="index" class="flex shrink-0 items-center" :class="single ? `h-5` : `h-[17px]`">
                <!-- Gutter appears in every pane regardless of layout: the one column a reader can always count on. -->
                <span class="flex shrink-0 justify-end" :class="single ? `w-16 pr-7` : split ? `w-20 gap-8 pr-3 @min-[44rem]:w-16 @min-[44rem]:pr-7` : `w-20 gap-8 pr-3`">
                    <span v-if="!single" class="skeleton block h-2" :class="[index < 9 ? `w-1.5` : `w-3.5`, split ? `@min-[44rem]:hidden` : ``]" />
                    <span class="skeleton block h-2" :class="index < 9 ? `w-1.5` : `w-3.5`" />
                </span>
                <!-- The app's own loading placeholder, not a hand-mixed tint of the same strength. -->
                <span v-if="line.width !== ``" class="skeleton block h-2 min-w-0 max-w-[85%] shrink" :class="[line.width, INDENT[line.level]]" />
            </span>
        </div>
    </div>
</template>
