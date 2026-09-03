<script setup lang="ts">
import { computed, ref } from "vue";

/* A TURN'S REASONING, FOLDED: the disclosure that holds an assistant message's thinking.
 *
 * Its own component because two transcripts draw it and neither is the other's frame: the conversation
 * (ChatMessageView) and a delegated agent's record (pages/Subagents.vue). The subagent view used to render
 * thinking as a plain run of italics with no fold at all, so a child that reasoned for a page pushed its own
 * work off the bottom of the pane, and the same content read as a different KIND of thing depending on which
 * agent had produced it. One component is what keeps the fold, the label, the spinner and the scroll cap from
 * being decided twice.
 *
 * OPEN WHILE THE TURN IS STREAMING, shut once it has landed, until the reader says otherwise: watching a model
 * think is worth the room while it is happening and is a footnote the moment the answer exists. The override is
 * per-instance and unset by default, so each message keeps its own state and none of them is remembered: this
 * is a glance, not a preference. */

const props = defineProps<{
    thinking: string;
    // Whether the turn this belongs to is still being written: what decides the default fold, and the only
    // state in which the header may spin.
    streaming: boolean;
}>();

const override = ref<boolean>();
const open = computed(() => override.value ?? props.streaming);
const toggle = (): void => {
    override.value = !open.value;
};
</script>

<template>
    <div class="w-full overflow-hidden rounded-lg border-l-2 border-line-strong bg-overlay/60">
        <button type="button" class="flex w-full items-center gap-1.5 px-2 py-1 text-2xs uppercase tracking-wide text-subtle" @click="toggle">
            <Icon class="text-2xs" :name="open ? 'chevron-down' : 'chevron-right'" />
            <span>Thinking</span>
            <Icon v-if="streaming" name="spinner" class="text-2xs" spin />
        </button>
        <!-- Capped and scrolled rather than clamped: reasoning is skimmed, so the room it may take is bounded
             and the rest is reachable in place, without moving the answer below it. -->
        <div v-if="open" class="scrollbar-thin max-h-64 overflow-auto whitespace-pre-wrap px-3 pb-2 text-xs leading-relaxed text-muted">
            {{ thinking }}
        </div>
    </div>
</template>
