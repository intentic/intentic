<script setup lang="ts">
import { computed } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import ChatAsideLane from "./ChatAsideLane.vue";
import type { ChatAsideMark } from "./chatAsides";
import ChatToolRows from "../../tools/ChatToolRows.vue";
import { useToolCalls } from "../../tools/useToolCalls";
import { summarizeRun } from "../../tools/toolRun";
import { useT } from "@intentic/ui/i18n";

const t = useT();

// What an assistant turn thought and did, on one lane: shared by the conversation (ChatMessageView) and a delegated
// agent's record (Subagents.vue) so both read the same. Both marks belong to one row, which is why they are decided
// here rather than by two components that would each claim a bar. Tool calls the reader asked to SEE are rows, never a
// mark — that setting is the whole of the question the mark otherwise asks.

const props = defineProps<{
    thinking?: string;
    tools?: readonly TranscriptTool[];
    // Whether the turn is still being written: the only state in which a mark may spin or open itself.
    live: boolean;
}>();

const { showToolCalls } = useToolCalls();

const run = computed(() => (showToolCalls.value ? undefined : summarizeRun(props.tools ?? [])));

// `sparkles` is the mark the think tool already carries (toolPresentation.ts).
const marks = computed<readonly ChatAsideMark[]>(() => [
    ...(props.thinking === undefined || props.thinking === ``
        ? []
        : [{ key: `thinking`, icon: `sparkles` as const, label: t(`chat.chatTurnAsides.thinking`), busy: props.live }]),
    ...(run.value === undefined
        ? []
        : [
              {
                  key: `tools`,
                  icon: run.value.icon,
                  label: `Show ${run.value.count} ${run.value.count === 1 ? `step` : `steps`}`,
                  count: run.value.count,
                  busy: run.value.running && props.live,
                  failed: run.value.failed,
              },
          ]),
]);

// A thought is read as it is written and shut once it lands; a run is not, since hiding it is what the reader asked for.
const openByDefault = computed(() => (props.thinking !== undefined && props.thinking !== `` && props.live ? `thinking` : undefined));
</script>

<template>
    <ChatAsideLane :marks="marks" :open-by-default="openByDefault">
        <template #thinking>
            <pre class="chat-inset max-h-64 overflow-auto px-2.5 py-1.5 text-2xs leading-relaxed whitespace-pre-wrap italic">{{ thinking }}</pre>
        </template>
        <template #tools>
            <div class="flex flex-col gap-1">
                <ChatToolRows :tools="tools ?? []" :live="live" />
            </div>
        </template>
    </ChatAsideLane>
    <!-- Shown inline, the run is what it always was: one row per call. -->
    <div v-if="showToolCalls && tools?.length" class="flex w-full flex-col gap-1">
        <ChatToolRows :tools="tools" :live="live" />
    </div>
</template>
