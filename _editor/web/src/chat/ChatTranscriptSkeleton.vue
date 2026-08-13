<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { onScopeDispose, ref } from "vue";

/* The outline of a conversation that has not arrived yet — what replaced the centred spinner.
 *
 * A spinner says only "wait". Over a transcript that is worth saying more than: this column is always the same
 * three shapes stacked (a prompt against the right edge, the tool rows a turn ran, the answer it wrote), so the
 * wait can be drawn as the layout the content will occupy. Two things come out of that. The reader knows what
 * is coming and roughly how much of it, and the arrival is content filling in its own outline rather than a
 * spinner in the middle of the panel being replaced by text that starts at the top — the eye is not asked to
 * re-anchor once the data lands.
 *
 * It is anchored to the BOTTOM because that is where a restored transcript lands: useStickToBottom follows the
 * growth, so the first thing the user reads is the end of the conversation. An outline stacked from the top
 * would preview a view nobody ever sees.
 */

// The shapes of a turn, per turn, newest last. Widths are a fixed uneven set rather than random ones: an outline
// that reshuffles on every re-render is an animation nobody asked for.
const TURNS = [
    { bubble: `w-[52%]`, prompt: [`w-full`, `w-1/2`], tools: [`w-1/3`], answer: [`w-full`, `w-5/6`] },
    { bubble: `w-[34%]`, prompt: [`w-full`], tools: [`w-2/5`, `w-1/4`], answer: [`w-full`, `w-full`, `w-3/4`, `w-2/5`] },
    { bubble: `w-[38%]`, prompt: [`w-full`], tools: [`w-2/5`], answer: [`w-full`, `w-11/12`, `w-3/5`] },
    { bubble: `w-[62%]`, prompt: [`w-full`, `w-2/3`], tools: [`w-1/2`, `w-1/3`], answer: [`w-full`, `w-full`, `w-4/5`, `w-2/5`] },
];
// Twice through, so the stack is taller than any panel it can be drawn in and the outline always reaches the top
// edge instead of leaving a band of empty transcript above itself. The turns that don't fit are clipped, never
// seen, and cost nothing; the repeat only becomes visible in a full-screen pop-out, where a repeating placeholder
// is what a placeholder looks like anyway.
const OUTLINE = [...TURNS, ...TURNS];

/* Past this the outline has stopped being informative — it promised content and the promise is overdue, and a
 * placeholder left pulsing at that point is indistinguishable from one that is stuck. This component's
 * lifetime IS the visible wait (ChatPanel mounts it through useLoadingReveal), so a timer armed at setup
 * measures exactly how long the user has been looking at it. */
const SLOW_AFTER_MS = 6_000;
const slow = ref(false);
const timer = setTimeout(() => (slow.value = true), SLOW_AFTER_MS);
onScopeDispose(() => clearTimeout(timer));
</script>

<template>
    <!-- The bars are decoration; role=status plus the sr-only line carry everything the centred
         "Loading conversation…" used to say, to the readers who needed it said. -->
    <!-- Out of flow, inside a box that grows to whatever height the transcript column has.
         The outline is deliberately taller than any panel it can be drawn in, and NOTHING it does may size the
         column it sits in: in flow, that height became .chat-turns' content-based minimum, which grew the single
         scroller the panel shares with its composer and pushed the composer off the bottom of the window. An
         absolutely positioned box contributes no intrinsic size, so the column stays exactly as tall as the space
         it was given and the overflow is clipped here rather than scrolled — a transcript with nothing in it yet
         must not have a scrollbar. -->
    <div class="relative min-h-0 flex-1" role="status" aria-busy="true">
        <span class="sr-only">Loading conversation…</span>
        <div class="chat-skeleton absolute inset-0 flex flex-col justify-end gap-1 overflow-hidden pb-2">
            <div v-for="(turn, index) in OUTLINE" :key="index" class="flex shrink-0 animate-pulse flex-col gap-1" aria-hidden="true">
                <!-- The prompt bubble, carrying .chat-prompt's own vertical padding so the turn keeps its rhythm. -->
                <div class="flex justify-end pt-3 pb-2">
                    <div class="chat-surface flex flex-col gap-1.5 rounded-lg px-3 py-2" :class="turn.bubble">
                        <span v-for="(line, lineIndex) in turn.prompt" :key="lineIndex" class="h-3 rounded bg-content/10" :class="line" />
                    </div>
                </div>
                <!-- Tool calls are bare rows at the meta tier — a glyph, a name, a target — not cards. -->
                <div class="flex flex-col gap-0.5">
                    <span v-for="(target, toolIndex) in turn.tools" :key="toolIndex" class="flex items-center gap-1.5">
                        <span class="h-2.5 w-2.5 shrink-0 rounded bg-content/25" />
                        <span class="h-2 w-10 shrink-0 rounded bg-content/10" />
                        <span class="h-2 rounded bg-content/10" :class="target" />
                    </span>
                </div>
                <div class="chat-surface-assistant flex flex-col gap-2 rounded-lg px-3.5 py-2.5">
                    <span v-for="(line, lineIndex) in turn.answer" :key="lineIndex" class="h-3 rounded bg-content/10" :class="line" />
                </div>
            </div>
            <p v-if="slow" class="flex shrink-0 items-center justify-center gap-2 pt-2 text-2xs text-subtle">
                <Icon name="spinner" spin class="text-2xs" />Still fetching this conversation from your sandbox…
            </p>
        </div>
    </div>
</template>
