<script setup lang="ts">
import type { Tip } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { relativeTime } from "../features/chat/models/catalog";
import { useT } from "@intentic/ui/i18n";

// Mark for words still sitting in the composer, shared by the fleet board card and chat rail row. The words
// show only on hover, not the face, since a board is often read over someone's shoulder. Opens downward: the
// mark sits under a session title in both frames, so an upward hover would cover it.

const t = useT();

const props = defineProps<{
    // Opening words of the unsent message; absent for an attachment or queued message, hover then omits the words.
    preview?: string;
    // When the composer first held it (Conversation.draftAt); absent for a chat restored with no stamp.
    at?: number;
}>();

// The mark reads the shared clock itself, armed only while it has a stamp to age, and quantized to the 15s that
// keeps a minute-granular age honest: a tick a second would redraw every unsent card for the same words.
const AGE_STEP_MS = 15_000;
const now = useNow(() => props.at !== undefined);
const aged = computed(() => Math.floor(now.value / AGE_STEP_MS) * AGE_STEP_MS);

// Reports what the card doesn't show: how long it has sat, and its opening words; a missing part drops out.
const age = computed(() => (props.at === undefined ? undefined : relativeTime(props.at, aged.value)));
const hint = computed<Tip>(() => ({
    title: t(`common.unsentMark.notSent`),
    rows: [{ label: t(`common.unsentMark.written`), value: age.value ?? `` }],
    note: props.preview,
}));
// The same parts in one line, since a tooltip itself isn't announced.
const spoken = computed(() => [t(`common.unsentMark.notSent`), age.value, props.preview].filter((part) => part !== undefined).join(`, `));
</script>

<template>
    <!-- `w-fit` keeps it a chip in both frames: a column would stretch a flex child into a banner, a row would not. -->
    <span
        v-tooltip.bottom="hint"
        :aria-label="spoken"
        class="ui-status-pill flex w-fit shrink-0 items-center gap-1 bg-primary-600/15 text-2xs font-semibold text-link"
    >
        <Icon name="send" class="shrink-0 text-2xs" />
        {{ t(`common.unsentMark.unsent`) }}
    </span>
</template>
