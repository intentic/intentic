<script setup lang="ts">
import { ui } from "@intentic/ui";
import { computed, ref } from "vue";
import { foldUnchanged, type ProseBlock, proseDiff } from "./proseDiff";

// A document's change drawn as tracked changes: one text, insertions underlined, deletions struck through, long
// unchanged stretches folded to a line. What a maker reads instead of a code diff for a markdown file; the toolbar's
// Prose/Code control is the way to the other reading.

const { before = ``, after = `` } = defineProps<{ before?: string; after?: string }>();

const blocks = computed(() => proseDiff(before, after));
// Folds the reader has opened, by the index of the first paragraph they hide; a new diff starts folded.
const opened = ref<ReadonlySet<number>>(new Set());
const runs = computed(() => foldUnchanged(blocks.value));
const open = (at: number): void => {
    opened.value = new Set([...opened.value, at]);
};
// A fold the reader opened is drawn as the paragraphs it stood for.
const unfolded = (at: number, count: number): readonly ProseBlock[] => blocks.value.slice(at, at + count);

const changed = computed(() => blocks.value.filter((block) => block.kind !== `same`).length);

const HEADING_CLASS: Record<number, string> = {
    1: `text-xl font-semibold`,
    2: `text-lg font-semibold`,
    3: `text-base font-semibold`,
    4: `text-sm font-semibold`,
    5: `text-sm font-medium`,
    6: `text-sm font-medium`,
};
const blockClass = (block: ProseBlock): string =>
    [
        block.heading === undefined ? `text-sm` : HEADING_CLASS[block.heading]!,
        // A whole paragraph added or dropped wears its mark on the margin too, so it reads as a block event.
        block.kind === `added` ? `border-l-2 border-success/60 pl-3` : block.kind === `removed` ? `border-l-2 border-danger/60 pl-3` : block.kind === `changed` ? `border-l-2 border-warning/60 pl-3` : `pl-3.5`,
    ].join(` `);
</script>

<template>
    <div class="scrollbar-thin h-full min-h-0 overflow-auto px-6 py-4">
        <p v-if="changed === 0" class="mb-4 text-2xs text-subtle">Nothing in the text changed; only spacing or line breaks did.</p>
        <div class="mx-auto flex max-w-3xl flex-col gap-4 leading-relaxed text-content">
            <template v-for="(run, index) in runs" :key="index">
                <template v-if="run.kind === `fold`">
                    <template v-if="opened.has(run.at)">
                        <p v-for="(block, offset) in unfolded(run.at, run.count)" :key="`${run.at}-${offset}`" class="whitespace-pre-wrap text-muted" :class="blockClass(block)">
                            {{ block.segments[0]?.text }}
                        </p>
                    </template>
                    <button v-else type="button" :class="ui.textAction(`pl-3.5 text-2xs italic text-subtle`)" @click="open(run.at)">
                        {{ run.count }} unchanged {{ run.count === 1 ? "paragraph" : "paragraphs" }}
                    </button>
                </template>
                <p v-else class="whitespace-pre-wrap" :class="[blockClass(run.block), run.block.kind === `same` ? `text-muted` : ``]">
                    <template v-for="(segment, at) in run.block.segments" :key="at">
                        <ins v-if="segment.kind === `added`" class="rounded-sm bg-success/15 text-content no-underline decoration-success underline decoration-2 underline-offset-2">{{ segment.text }}</ins>
                        <del v-else-if="segment.kind === `removed`" class="rounded-sm bg-danger/10 text-muted line-through decoration-danger/70">{{ segment.text }}</del>
                        <template v-else>{{ segment.text }}</template>
                    </template>
                </p>
            </template>
        </div>
    </div>
</template>
