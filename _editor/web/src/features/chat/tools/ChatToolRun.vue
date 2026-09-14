<script setup lang="ts">
import { computed, ref } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import ChatToolRows from "./ChatToolRows.vue";
import { summarizeRun } from "./toolRun";

// A hidden turn's tool calls: a mark with the count and the most notable call's icon.
// Quiet by design, since an aside must not compete with the narration beside it. Opened, it shows the exact
// rows the shown mode draws (ChatToolRows); there's no third rendering of a tool call.

const props = defineProps<{
    tools: readonly TranscriptTool[];
    // Whether the turn is still streaming: the only state the mark may animate in.
    live: boolean;
}>();

const run = computed(() => summarizeRun(props.tools));

const expanded = ref(false);
const toggle = (): void => {
    expanded.value = !expanded.value;
};

const hint = computed(() => {
    const count = run.value?.count ?? 0;
    const steps = count === 1 ? `1 step` : `${count} steps`;
    return expanded.value ? `Hide ${steps}` : `Show ${steps}`;
});
</script>

<template>
    <div v-if="run" class="flex w-full flex-col">
<!-- The whole join is the hit target, not just the end mark, since a badge-sized area between paragraphs is easy to miss. -->
        <button
            type="button"
            class="chat-run-bar group/run relative flex w-full items-center justify-end"
            :class="expanded && 'chat-run-bar-open'"
            :aria-expanded="expanded"
            :aria-label="hint"
            @click="toggle"
        >
            <span
                class="chat-run-mark flex shrink-0 items-center gap-1 rounded-full px-2.25 py-0.75 text-2xs tabular-nums ring-(length:--ring-hairline) transition-colors"
                :class="[
                    run.failed
                        ? 'text-danger ring-danger/40'
                        : expanded
                          ? 'bg-overlay text-content ring-line-strong'
                          : 'bg-card text-muted ring-line',
                    'group-hover/run:bg-overlay group-hover/run:text-content group-hover/run:ring-line-strong',
                ]"
            >
                <!-- Spins only while live: a run still filling up is the one thing here worth animating. -->
                <Icon v-if="run.running && live" name="spinner" :spin="true" class="text-2xs" />
                <Icon v-else :name="run.icon" class="text-2xs" />
                {{ run.count }}
            </span>
        </button>
<!-- Opened runs use an in-flow transition and remain absent when closed. -->
        <Transition name="chat-run-reveal">
            <div v-if="expanded" class="grid">
                <div class="min-h-0 overflow-hidden">
                    <div class="flex flex-col gap-1">
                        <ChatToolRows :tools="tools" :live="live" />
                    </div>
                </div>
            </div>
        </Transition>
    </div>
</template>
