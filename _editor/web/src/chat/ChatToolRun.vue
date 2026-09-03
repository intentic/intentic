<script setup lang="ts">
import { computed, ref } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import ChatToolRows from "./ChatToolRows.vue";
import { summarizeRun } from "./toolRun";

/* WHAT A TURN'S TOOL CALLS LOOK LIKE WHEN THEY ARE HIDDEN: a soft rule running out to the right of the
 * transcript, ending in a mark that says how many calls there were and what the most notable of them was.
 *
 * It is a JOIN, not a row. A turn's narration is the thing being read; the calls behind it are an aside, and an
 * aside drawn at the weight of a row competes with the sentences on either side of it, which is the whole
 * reason they are hidden. So: no fill, no box, a hairline that fades in from the left and leads the eye out to
 * the one mark that carries information. Everything about it is quiet except the fact that it is there.
 *
 * Opened, it shows the very same rows the shown mode draws (ChatToolRows): for this run only, and only until
 * it is clicked shut. There is no third rendering of a tool call anywhere in the app. */

const props = defineProps<{
    tools: readonly TranscriptTool[];
    // Whether the turn this run belongs to is still streaming: the only state in which the mark may animate.
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
        <!-- The whole join is the target, not just the mark on the end of it: the rule is part of the same
             affordance, and a badge-sized hit area between two paragraphs is a thing you miss. Where the two
             stand relative to each other, and what happens to the line when the run opens: is chat.css's,
             because it is a question about the width of the pane rather than about this run. -->
        <button
            type="button"
            class="chat-run-bar group/run relative flex w-full items-center gap-2"
            :class="expanded && 'chat-run-bar-open'"
            :aria-expanded="expanded"
            :aria-label="hint"
            @click="toggle"
        >
            <!-- Fades in from the left and arrives at the mark: the gradient is what makes this read as a line
                 LEADING somewhere rather than as a divider cutting the transcript in half. -->
            <span
                class="chat-run-line h-px flex-1 bg-gradient-to-r from-transparent transition-colors"
                :class="run.failed ? 'via-danger/25 to-danger/50' : 'via-line to-line group-hover/run:via-line-strong group-hover/run:to-line-strong'"
            ></span>
            <!-- The ring is PAINTED, not a border: `border-width` never renders below one CSS pixel, Chromium
                 clamps a 0.5px border back up to 1px, whereas a box-shadow spread is rasterized, so half a
                 pixel is half a pixel wherever the display can resolve one (measured: one device pixel against
                 a 1px border's two, at 2×). Below that it rounds up to the single pixel it always was, so the
                 hairline needs no media query to degrade. Weight is the whole point here: at this size a
                 full-pixel ring is heavier than the line the mark stands on, which makes an aside read as a
                 control.
                 A painted ring is out of the LAYOUT, though, where the border it replaced was in it, so the
                 padding takes back the pixel the border used to occupy at each edge (2 + 1/4 and 3/4 against
                 the old 2 and 1/2). The pill is the size it has always been; only its edge got finer. -->
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
                <!-- While the turn is live the mark spins in place of its icon: a run that is still filling up
                     is the one thing about it worth animating, and the count beside it is already moving. -->
                <Icon v-if="run.running && live" name="spinner" :spin="true" class="text-2xs" />
                <Icon v-else :name="run.icon" class="text-2xs" />
                {{ run.count }}
            </span>
        </button>
        <!-- The calls arrive by growing into place rather than appearing whole: opening a run moves everything
             below it down by however tall the run happens to be, and a jump that size, under the sentence you
             are reading, costs you your place. The reveal is short enough not to be a wait (see chat.css).
             Still `v-if`, not a hidden block: a transcript holds hundreds of runs and only the opened one has
             any business being in the DOM: the rows are mounted when the run opens and dropped when it shuts.
             The grid wrapper is the mechanism: a single row that transitions from no height to its content's,
             which is the one way to animate to a height nobody knows in advance. -->
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
