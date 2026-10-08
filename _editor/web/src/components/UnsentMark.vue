<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import { timeAgo } from "@intentic/ui";

// Mark for words still sitting in the composer, shared by the fleet board card and chat rail row. The visible chip says
// "Unsent"; age and opening words live in the accessible name only, not a hover card, since the badge already states the fact.

const t = useT();

const props = defineProps<{
    // Opening words of the unsent message, or how to read them; absent for an attachment or queued message. A reader keeps
    // the read in this mark: a composer's words change on every keystroke, and read in the slot of the card that holds the
    // mark (ChatTabRow), each one redrew the whole card and everything on it.
    preview?: string | (() => string | undefined);
    // When the composer first held it (Conversation.draftAt); absent for a chat restored with no stamp.
    at?: number;
}>();

// The mark reads the shared clock itself, armed only while it has a stamp to age, and quantized to the 15s that
// keeps a minute-granular age honest: a tick a second would redraw every unsent card for the same words.
const AGE_STEP_MS = 15_000;
const now = useNow(() => props.at !== undefined);
const aged = computed(() => Math.floor(now.value / AGE_STEP_MS) * AGE_STEP_MS);

const age = computed(() => (props.at === undefined ? undefined : timeAgo(props.at, { now: aged.value, days: true })));
const words = computed(() => (typeof props.preview === `function` ? props.preview() : props.preview));
const spoken = computed(() => [t(`common.unsentMark.notSent`), age.value, words.value].filter((part) => part !== undefined).join(`, `));
</script>

<template>
    <!-- `w-fit` keeps it a chip in both frames: a column would stretch a flex child into a banner, a row would not. -->
    <span
        :aria-label="spoken"
        class="ui-status-pill flex w-fit shrink-0 items-center gap-1 bg-primary-600/15 text-2xs font-semibold text-link"
    >
        <Icon name="send" class="shrink-0 text-2xs" />
        {{ t(`common.unsentMark.unsent`) }}
    </span>
</template>
