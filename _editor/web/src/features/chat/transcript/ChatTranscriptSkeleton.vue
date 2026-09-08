<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { onScopeDispose, ref } from "vue";

// Placeholder for a transcript that hasn't arrived: previews the layout (prompt, tool rows, answer) content will
// occupy, so arrival fills its own outline instead of replacing a spinner. Anchored to the bottom, since that's where a
// restored transcript lands (useStickToBottom).

// Per-turn skeleton shapes, newest last; fixed uneven widths so the outline doesn't reshuffle on re-render.
const TURNS = [
    { bubble: `w-[52%]`, prompt: [`w-full`, `w-1/2`], tools: [`w-1/3`], answer: [`w-full`, `w-5/6`] },
    { bubble: `w-[34%]`, prompt: [`w-full`], tools: [`w-2/5`, `w-1/4`], answer: [`w-full`, `w-full`, `w-3/4`, `w-2/5`] },
    { bubble: `w-[38%]`, prompt: [`w-full`], tools: [`w-2/5`], answer: [`w-full`, `w-11/12`, `w-3/5`] },
    { bubble: `w-[62%]`, prompt: [`w-full`, `w-2/3`], tools: [`w-1/2`, `w-1/3`], answer: [`w-full`, `w-full`, `w-4/5`, `w-2/5`] },
];
// Repeated twice so the stack always reaches the top edge; turns that overflow are clipped and cost nothing.
const OUTLINE = [...TURNS, ...TURNS];

// Past this the placeholder looks stuck, not loading; the timer starts at mount, the whole visible wait.
const SLOW_AFTER_MS = 6_000;
const slow = ref(false);
const timer = setTimeout(() => (slow.value = true), SLOW_AFTER_MS);
onScopeDispose(() => clearTimeout(timer));
</script>

<template>
    <!-- Bars are decoration; role=status plus the sr-only line carry the announcement for screen readers. -->
    <!-- Absolutely positioned so it adds no intrinsic size; in flow it would grow the shared scroller. -->
    <div class="relative min-h-0 flex-1" role="status" aria-busy="true">
        <span class="sr-only">Loading conversation…</span>
        <div class="chat-skeleton absolute inset-0 flex flex-col justify-end gap-1 overflow-hidden pb-2">
            <div v-for="(turn, index) in OUTLINE" :key="index" class="flex shrink-0 flex-col gap-1" aria-hidden="true">
                <!-- Padding here matches .chat-prompt's own vertical padding. -->
                <div class="flex justify-end pt-3 pb-2">
                    <div class="chat-surface flex flex-col gap-1.5 rounded-lg px-3 py-2" :class="turn.bubble">
                        <span v-for="(line, lineIndex) in turn.prompt" :key="lineIndex" class="h-3 rounded bg-content/10" :class="line" />
                    </div>
                </div>
                <!-- Tool calls are bare rows at the meta tier: a glyph, a name, a target, not cards. -->
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
