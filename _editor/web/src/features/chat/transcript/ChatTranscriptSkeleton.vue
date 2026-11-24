<script setup lang="ts">
import { Button, Icon, SkeletonSnapshot } from "@intentic/ui";
import { onScopeDispose, ref } from "vue";
import { useT } from "@intentic/ui/i18n";

// Placeholder for a transcript that hasn't arrived. Before the conversation has been seen once it promises what a
// transcript's first screen is: the context chip and the day it started at the top, then turns of a prompt bubble, its
// folded steps and an answer, in the transcript's own classes, filling down until the pane clips them. From then on its own
// last turns, as they were last drawn, stand in for them, anchored to the bottom where a restored transcript lands
// (useStickToBottom). Without a name (a host that asked for a quiet wait, transcriptWait.ts) there is no outline at all:
// one line at the foot, where the transcript will land.
const t = useT();

const { of } = defineProps<{
    // The name ChatPaneTurns keeps this conversation's turns under (`v-skeleton-source`); absent for a quiet wait.
    of?: string;
}>();

// Per-turn line widths, oldest first; fixed and uneven so the outline doesn't reshuffle on re-render. A prompt is a line
// or two, its steps fold to one band (ChatStepGroup), and its answer is a paragraph. Three fill a tall pane; the stack
// clips what does not fit.
const TURNS = [
    { prompt: [`w-64`, `w-40`], answer: [`w-full`, `w-full`, `w-11/12`, `w-full`, `w-3/5`] },
    { prompt: [`w-48`], answer: [`w-full`, `w-5/6`, `w-full`, `w-2/5`] },
    { prompt: [`w-60`, `w-28`], answer: [`w-full`, `w-full`, `w-3/4`] },
];

// Asks the sandbox again (the pane's hydration), offered once the wait is past what a read ever takes.
const emit = defineEmits<{ retry: [] }>();

// Past the first the placeholder looks stuck, not loading; past the second it has been stuck longer than any read takes
// (one sat here for minutes over a subagent waiting on a permission), so it says so and offers to ask again. Timed from
// mount, the whole visible wait, and from each Retry after it.
const SLOW_AFTER_MS = 6_000;
const STALLED_AFTER_MS = 18_000;
const slow = ref(false);
const stalled = ref(false);
let timers: ReturnType<typeof setTimeout>[] = [];
const arm = (): void => {
    timers.forEach(clearTimeout);
    timers = [setTimeout(() => (slow.value = true), SLOW_AFTER_MS), setTimeout(() => (stalled.value = true), STALLED_AFTER_MS)];
};
arm();
onScopeDispose(() => timers.forEach(clearTimeout));
const retry = (): void => {
    stalled.value = false;
    arm();
    emit(`retry`);
};
</script>

<template>
    <!-- Bars are decoration; role=status plus the sr-only line carry the announcement for screen readers. -->
    <!-- Absolutely positioned so it adds no intrinsic size; in flow it would grow the shared scroller. -->
    <div class="relative min-h-0 flex-1" role="status" aria-busy="true">
        <span v-if="of !== undefined" class="sr-only">{{ t(`chat.chatTranscriptSkeleton.loadingConversation`) }}</span>
        <!-- The remembered turns (`data-skeleton-snapshot`) take the top when they fit, as a short chat's own turns do,
             and the bottom when they don't, as a long one opens on its last. -->
        <div class="chat-skeleton absolute inset-0 flex flex-col justify-end gap-1 overflow-hidden pb-2 [&>[data-skeleton-snapshot]]:mb-auto">
            <!-- Only the bars are remembered: the notes below keep timing the wait and offering to ask again. The status
                 above already announces it, so the remembered turns stay silent. -->
            <SkeletonSnapshot v-if="of !== undefined" :of="of">
                <!-- The column's head as ChatPaneTurns draws it: the context chip (ChatSystemPrompt), then the turns' stack
                     opening on the day mark. The stack takes the rest and clips, so the notes below stay at the foot. -->
                <div class="flex shrink-0 justify-center pb-1" aria-hidden="true"><span class="ui-chip"><span class="skeleton block h-2 w-14" /></span></div>
                <div class="chat-stack flex min-h-0 flex-1 flex-col overflow-hidden" aria-hidden="true">
                    <div class="flex shrink-0 justify-center pb-0.5 text-2xs">
                        <span class="flex h-[1lh] items-center"><span class="skeleton block h-2 w-20" /></span>
                    </div>
                    <section v-for="(turn, index) in TURNS" :key="index" class="chat-stack flex shrink-0 flex-col">
                        <!-- Padding here matches .chat-prompt's own; the bubble is .chat-prompt-text's type and padding. -->
                        <div class="flex justify-end pt-3 pb-2">
                            <div class="chat-surface flex max-w-[85%] flex-col px-4 py-2.5 text-xs leading-relaxed">
                                <span v-for="(line, lineIndex) in turn.prompt" :key="lineIndex" class="flex h-[1lh] items-center">
                                    <span class="skeleton block h-2.5" :class="line" />
                                </span>
                            </div>
                        </div>
                        <!-- A finished turn's steps, folded to their band (ChatStepGroup's .chat-spine-wash). -->
                        <span class="chat-spine-wash pointer-events-none [--wash-height:0.5rem]" />
                        <div class="chat-surface-assistant flex w-full flex-col rounded-lg px-3.5 py-2.5 text-xs leading-relaxed">
                            <span v-for="(line, lineIndex) in turn.answer" :key="lineIndex" class="flex h-[1lh] items-center">
                                <span class="skeleton block h-2.5" :class="line" />
                            </span>
                        </div>
                    </section>
                </div>
            </SkeletonSnapshot>
            <p v-if="stalled" class="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-2 text-2xs text-subtle" role="alert">
                <span>{{ t(`chat.chatTranscriptSkeleton.takingLonger`) }}</span>
                <Button size="small" tier="accent" @click="retry">{{ t(`chat.chatTranscriptSkeleton.retry`) }}</Button>
            </p>
            <p v-else-if="slow" class="flex shrink-0 items-center justify-center gap-2 pt-2 text-2xs text-subtle">
                <Icon name="spinner" spin class="text-2xs" />{{ t(`chat.chatTranscriptSkeleton.stillFetchingConversationSandbox`) }}
            </p>
            <!-- The quiet wait's one line, said rather than read only to a screen reader: there are no bars to show it. -->
            <p v-else-if="of === undefined" class="flex shrink-0 items-center justify-center gap-2 pt-2 text-2xs text-subtle">
                <Icon name="spinner" spin class="text-2xs" />{{ t(`chat.chatTranscriptSkeleton.loadingConversation`) }}
            </p>
        </div>
    </div>
</template>
