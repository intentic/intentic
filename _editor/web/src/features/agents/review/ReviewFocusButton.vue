<script setup lang="ts">
import { Button, type Tip } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onUnmounted } from "vue";
import { exitReviewFocus, reviewFocused, toggleReviewFocus } from "../../../workbench/window/reviewFocus";

// FOCUS REVIEW (reviewFocus.ts), in the review's header: the review takes the window, and the same press, now saying
// Exit focus, puts the side panel, the chat and the terminal back exactly as they were. Words, not a bare glyph, once
// the header has the room: the press is how a cramped review is found to have a way out. Focus is this review's
// arrangement, so the press leaving the screen (the review closed, another page opened) ends it too.

const t = useT();

const label = computed(() => (reviewFocused.value ? t(`agents.agentDetail.exitFocus`) : t(`agents.agentDetail.focusReview`)));
const tip = computed(
    (): Tip => ({ title: label.value, note: reviewFocused.value ? t(`agents.agentDetail.exitFocusHint`) : t(`agents.agentDetail.focusReviewHint`) }),
);

onUnmounted(exitReviewFocus);
</script>

<template>
    <Button
        size="small"
        :tier="reviewFocused ? `boring` : `quiet`"
        class="shrink-0 whitespace-nowrap"
        :aria-label="label"
        v-tooltip.bottom="tip"
        @click="toggleReviewFocus"
    >
        <Icon :name="reviewFocused ? `compress` : `expand`" />
        <span class="hidden @sm:inline">{{ label }}</span>
    </Button>
</template>
