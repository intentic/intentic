<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import { timeAgo } from "@intentic/ui";

// Mark for words still sitting in the composer: a bare pencil in a card's corner, beside its standing, on the fleet board
// card (AgentCard) and the chat rail row (ChatTabRow) alike, whether or not the conversation ever sent anything. ONE
// shape on purpose: the pill and identity-tile badge this used to offer let each host pick its own, and the two surfaces
// drifted apart. Called a DRAFT, under a pencil: "Unsent" read as a send that failed (which ChatUnsentLine is), and a
// paper plane as the Send press or "sent". Age and opening words live in the accessible name and the hover, since a
// lone glyph states no fact.

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
const spoken = computed(() => [t(`common.unsentMark.draft`), age.value, words.value].filter((part) => part !== undefined).join(`, `));
</script>

<template>
    <!-- At the host's stamp size: the host sets the font size, as it does for its CardStamps. -->
    <span v-tooltip.top="spoken" role="img" :aria-label="spoken" data-unsent-mark class="inline-flex shrink-0 items-center text-link">
        <Icon name="pencil" />
    </span>
</template>
