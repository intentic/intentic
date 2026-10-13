<script setup lang="ts">
import { computed, ref } from "vue";
import type { TipRow, TooltipValue } from "@intentic/ui";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import ChatToolRows from "../../tools/ChatToolRows.vue";
import ChatSpineNode from "./ChatSpineNode.vue";
import { useToolCalls } from "../../tools/useToolCalls";
import { summarizeRun, type RunKind } from "../../tools/toolRun";
import { useT } from "@intentic/ui/i18n";
import { useAudience } from "../../../../app/useAudience";

const t = useT();

// What an assistant row thought and did before its words, as ONE figure on the spine down the column's left edge
// (`.chat-spine` in chat.css): a glyph and a count in the seam between the paragraph before and the words the run led
// to, costing the row no height. Pressed, the thought and the calls open in place under it. The right edge is left to
// what the reader can DO (fork, edit): the left is what the agent did. Tool calls the reader asked to SEE are rows,
// never counted on a figure, since that setting is the whole of the question the figure asks.

const props = defineProps<{
    thinking?: string;
    tools?: readonly TranscriptTool[];
    // Whether the turn is still being written: the only state in which its band may breathe.
    live: boolean;
}>();

const { showToolCalls } = useToolCalls();
const { maker } = useAudience();

const thought = computed(() => (props.thinking === undefined || props.thinking === `` ? undefined : props.thinking));
const run = computed(() => (showToolCalls.value ? undefined : summarizeRun(props.tools ?? [])));

// A thought is a step like any call: it stands under the same shut band and opens only when the reader asks, live or
// not, so no row of the transcript unfolds itself while the reader is reading another.
const shown = ref(false);
// Opened by find-in-page: shown at once, since the browser scrolls to the match before a reveal would finish.
const found = ref(false);
const toggle = (): void => {
    found.value = false;
    shown.value = !shown.value;
};
const onFound = (): void => {
    found.value = true;
    shown.value = true;
};

const KIND_LABELS = {
    subagents: () => (maker.value ? t(`chat.chatTurnAsides.kindSubagentsMaker`) : t(`chat.chatTurnAsides.kindSubagents`)),
    edits: () => t(`chat.chatTurnAsides.kindEdits`),
    commands: () => t(`chat.chatTurnAsides.kindCommands`),
    web: () => t(`chat.chatTurnAsides.kindWeb`),
    searches: () => t(`chat.chatTurnAsides.kindSearches`),
    reads: () => t(`chat.chatTurnAsides.kindReads`),
    other: () => t(`chat.chatTurnAsides.kindOther`),
} satisfies Record<RunKind, () => string>;

// How hard the run worked, felt rather than counted: the seam above the words grows a step taller and a step deeper
// per call (`.chat-spine-wash` in chat.css), capped so a long run is a band, not a wall. The figure is on hover.
const WASH_CAP = 16;
// The thought counts as one step of the band, so a row that only thought still has one to press.
const steps = computed(() => (run.value?.count ?? 0) + (thought.value === undefined ? 0 : 1));
const calls = computed(() => (steps.value === 0 ? undefined : Math.min(steps.value, WASH_CAP)));

// For the screen reader and for a node the pointer has not reached: what a press opens.
const label = computed(() => {
    const count = run.value?.count;
    if (count === undefined) {
        return t(`chat.chatTurnAsides.thinking`);
    }
    return thought.value === undefined
        ? t(`chat.chatTurnAsides.showSteps`, { count }, count)
        : t(`chat.chatTurnAsides.showThinkingAndSteps`, { count }, count);
});

// The count broken into what the calls did, so a hover answers "what was that" without opening anything.
const tip = computed((): TooltipValue => {
    const summary = run.value;
    if (summary === undefined) {
        return t(`chat.chatTurnAsides.thinking`);
    }
    const rows: TipRow[] = summary.kinds.map(({ kind, count }) => ({ label: KIND_LABELS[kind](), value: count }));
    if (summary.failed > 0) {
        rows.push({ label: t(`chat.chatTurnAsides.failed`), value: summary.failed, tone: `danger` });
    }
    return {
        title: t(`chat.chatTurnAsides.steps`, { count: summary.count }, summary.count),
        rows,
        note: thought.value === undefined ? undefined : t(`chat.chatTurnAsides.thoughtFirst`),
    };
});
</script>

<template>
    <!-- The row's first child, so its zero-height bar sits on the row's top edge and the figure centres on the seam above
         the row's words. Shut, the thought and the hidden run are one band in that seam, as tall as the row was busy. -->
    <div
        v-if="calls !== undefined"
        class="chat-spine flex w-full flex-col gap-1"
        :class="shown ? `chat-spine-open` : `chat-spine-shut`"
        :style="{ '--wash-calls': calls }"
    >
        <div class="chat-spine-bar">
            <!-- Open, the band gives way to the material and one quiet mark in the gutter, sticky down it, folds it again. -->
            <ChatSpineNode
                v-if="shown"
                icon="chevron-up"
                :open="true"
                :label="label"
                :tip="tip"
                :failed="(run?.failed ?? 0) > 0"
                :live="live"
                @toggle="toggle"
            />
        </div>
        <!-- The row's weight as the seam itself, never a number, and the one control for the thought and the calls. -->
        <button
            v-if="!shown"
            type="button"
            class="chat-spine-wash"
            :class="{
                'chat-spine-wash-failed': (run?.failed ?? 0) > 0,
                'chat-spine-wash-live': live,
            }"
            :aria-expanded="false"
            :aria-label="label"
            v-tooltip.top="tip"
            @click="toggle"
        />
        <!-- One node open or shut: beforematch reveals the element it fired on, and a swapped-in copy would lose the
             match. Cheap text, so it stays in the page while shut for find-in-page to reach. The material is its own
             scroll box, never a box inside it (`.chat-mark-material` in chat.css). -->
        <div
            v-if="thought !== undefined"
            class="chat-mark-material chat-spine-material chat-inset max-h-64 overflow-auto"
            :class="found && `chat-mark-found`"
            :hidden.attr="shown ? undefined : `until-found`"
            @beforematch="onFound"
        >
            <!-- A thought is prose, so it is set in the reading face: a <pre> keeps its line breaks, not its code font. -->
            <pre class="px-2.5 py-1.5 font-sans text-2xs leading-relaxed whitespace-pre-wrap text-muted italic">{{ thought }}</pre>
        </div>
        <!-- The calls are not text worth the page's weight: absent until pressed, and faded in where they land. -->
        <Transition name="chat-mark-reveal">
            <div v-if="shown && run" class="chat-spine-material flex flex-col gap-1">
                <ChatToolRows :tools="tools ?? []" :live="live" />
            </div>
        </Transition>
    </div>
    <!-- Shown inline, the run is what it always was: one row per call. -->
    <div v-if="showToolCalls && tools?.length" class="flex w-full flex-col gap-1">
        <ChatToolRows :tools="tools" :live="live" />
    </div>
</template>
