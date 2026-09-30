<script setup lang="ts">
import { computed, ref } from "vue";
import type { TipRow, TooltipValue } from "@intentic/ui";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import ChatToolRows from "../../tools/ChatToolRows.vue";
import ChatSpineNode from "./ChatSpineNode.vue";
import { useToolCalls } from "../../tools/useToolCalls";
import { summarizeRun, type RunKind } from "../../tools/toolRun";
import { useT } from "@intentic/ui/i18n";

const t = useT();

// What an assistant row thought and did before its words, as ONE figure on the spine down the column's left edge
// (`.chat-spine` in chat.css): a glyph and a count in the seam between the paragraph before and the words the run led
// to, costing the row no height. Pressed, the thought and the calls open in place under it. The right edge is left to
// what the reader can DO (fork, edit): the left is what the agent did. Tool calls the reader asked to SEE are rows,
// never counted on a figure, since that setting is the whole of the question the figure asks.

const props = defineProps<{
    thinking?: string;
    tools?: readonly TranscriptTool[];
    // Whether the turn is still being written: the only state in which a node may breathe or open itself.
    live: boolean;
}>();

const { showToolCalls } = useToolCalls();

const thought = computed(() => (props.thinking === undefined || props.thinking === `` ? undefined : props.thinking));
const run = computed(() => (showToolCalls.value ? undefined : summarizeRun(props.tools ?? [])));

// What stands open under the node: the thought alone, which a live row opens by itself as it is written, or the whole
// of it, which only the reader asks for — a run is not opened for them, since hiding it is what they chose.
type Shown = `thought` | `all`;
// Unset until pressed, so a live thought keeps opening itself; null is the reader having shut it.
const override = ref<Shown | null>();
const shown = computed<Shown | undefined>(() =>
    override.value === undefined ? (thought.value !== undefined && props.live ? `thought` : undefined) : (override.value ?? undefined),
);
// Opened by find-in-page: shown at once, since the browser scrolls to the match before a reveal would finish.
const found = ref(false);
const toggle = (): void => {
    found.value = false;
    override.value = shown.value === undefined ? `all` : null;
};
const onFound = (): void => {
    found.value = true;
    override.value = `all`;
};

const KIND_LABELS = {
    subagents: () => t(`chat.chatTurnAsides.kindSubagents`),
    edits: () => t(`chat.chatTurnAsides.kindEdits`),
    commands: () => t(`chat.chatTurnAsides.kindCommands`),
    web: () => t(`chat.chatTurnAsides.kindWeb`),
    searches: () => t(`chat.chatTurnAsides.kindSearches`),
    reads: () => t(`chat.chatTurnAsides.kindReads`),
    other: () => t(`chat.chatTurnAsides.kindOther`),
} satisfies Record<RunKind, () => string>;

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
         the row's words. Shut, the whole of it costs the row nothing (chat.css cancels the gap after it). -->
    <div
        v-if="thought !== undefined || run !== undefined"
        class="chat-spine flex w-full flex-col gap-1"
        :class="shown ? `chat-spine-open` : `chat-spine-shut`"
    >
        <div class="chat-spine-bar">
            <ChatSpineNode
                :icon="thought === undefined ? undefined : `sparkles`"
                :count="run?.count"
                :open="shown !== undefined"
                :label="label"
                :tip="tip"
                :failed="(run?.failed ?? 0) > 0"
                :live="live"
                @toggle="toggle"
            />
        </div>
        <!-- One node open or shut: beforematch reveals the element it fired on, and a swapped-in copy would lose the
             match. Cheap text, so it stays in the page while shut for find-in-page to reach. -->
        <div
            v-if="thought !== undefined"
            class="chat-mark-material chat-spine-material"
            :class="found && `chat-mark-found`"
            :hidden.attr="shown ? undefined : `until-found`"
            @beforematch="onFound"
        >
            <pre class="chat-inset max-h-64 overflow-auto px-2.5 py-1.5 text-2xs leading-relaxed whitespace-pre-wrap italic">{{ thought }}</pre>
        </div>
        <!-- The calls are not text worth the page's weight: absent until pressed, and faded in where they land. -->
        <Transition name="chat-mark-reveal">
            <div v-if="shown === `all` && run" class="chat-spine-material flex flex-col gap-1">
                <ChatToolRows :tools="tools ?? []" :live="live" />
            </div>
        </Transition>
    </div>
    <!-- Shown inline, the run is what it always was: one row per call. -->
    <div v-if="showToolCalls && tools?.length" class="flex w-full flex-col gap-1">
        <ChatToolRows :tools="tools" :live="live" />
    </div>
</template>
