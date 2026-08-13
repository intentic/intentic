<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatTool } from "../composables/chat/transcript";
import ChatToolRows from "./ChatToolRows.vue";
import { summarizeRun } from "./toolRun";

/* WHAT A TURN'S TOOL CALLS LOOK LIKE WHEN THEY ARE HIDDEN: a soft rule running out to the right of the
 * transcript, ending in a mark that says how many calls there were and what the most notable of them was.
 *
 * It is a JOIN, not a row. A turn's narration is the thing being read; the calls behind it are an aside, and an
 * aside drawn at the weight of a row competes with the sentences on either side of it — which is the whole
 * reason they are hidden. So: no fill, no box, a hairline that fades in from the left and leads the eye out to
 * the one mark that carries information. Everything about it is quiet except the fact that it is there.
 *
 * Opened, it shows the very same rows the shown mode draws (ChatToolRows) — for this run only, and only until
 * it is clicked shut. There is no third rendering of a tool call anywhere in the app. */

const props = defineProps<{
    tools: readonly ChatTool[];
    // Whether the turn this run belongs to is still streaming — the only state in which the mark may animate.
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
    <div v-if="run" class="flex w-full flex-col gap-1">
        <!-- The whole join is the target, not just the mark on the end of it: the rule is part of the same
             affordance, and a badge-sized hit area between two paragraphs is a thing you miss. -->
        <button
            type="button"
            class="group/run flex w-full items-center gap-2 py-0.5"
            :aria-expanded="expanded"
            :aria-label="hint"
            v-tooltip.top="hint"
            @click="toggle"
        >
            <!-- Fades in from the left and arrives at the mark: the gradient is what makes this read as a line
                 LEADING somewhere rather than as a divider cutting the transcript in half. -->
            <span
                class="h-px flex-1 bg-gradient-to-r from-transparent transition-colors"
                :class="
                    run.failed ? 'via-danger/25 to-danger/50' : 'via-line to-line group-hover/run:via-line-strong group-hover/run:to-line-strong'
                "
            ></span>
            <span
                class="flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-2xs tabular-nums transition-colors"
                :class="[
                    run.failed
                        ? 'border-danger/40 text-danger'
                        : expanded
                          ? 'border-line-strong bg-overlay text-content'
                          : 'border-line bg-card text-muted',
                    'group-hover/run:border-line-strong group-hover/run:bg-overlay group-hover/run:text-content',
                ]"
            >
                <!-- While the turn is live the mark spins in place of its icon: a run that is still filling up
                     is the one thing about it worth animating, and the count beside it is already moving. -->
                <Icon v-if="run.running && live" name="spinner" :spin="true" class="text-2xs" />
                <Icon v-else :name="run.icon" class="text-2xs" />
                {{ run.count }}
            </span>
        </button>
        <div v-if="expanded" class="flex flex-col gap-1">
            <ChatToolRows :tools="tools" :live="live" />
        </div>
    </div>
</template>
