<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import { timeAgo } from "@intentic/ui";

// Mark for words still sitting in the composer, shared by the fleet board card and chat rail row. Called a DRAFT, under
// a pencil: "Unsent" read as a send that failed (which ChatUnsentLine is), and a paper plane as the Send press or "sent".
// Two shapes, by whether the draft is the card's whole standing:
// - the pill, for a card that has never sent anything: it takes the corner where every standing is said, in a word;
// - the badge, for a conversation with a standing of its own (running, asking, done): a pencil pinned to the identity
//   tile, so the corner keeps what the conversation is doing and the tile keeps saying which conversation it is (the
//   chat rail's row);
// - the stamp, on a fleet board card whatever its standing: a bare pencil in the corner's stamp list (CardStamps),
//   beside the standing, so every draft on the board reads the same way.
// Age and opening words live in the accessible name, and in the badge's hover, since a lone glyph states no fact.

const t = useT();

const props = defineProps<{
    // Opening words of the unsent message, or how to read them; absent for an attachment or queued message. A reader keeps
    // the read in this mark: a composer's words change on every keystroke, and read in the slot of the card that holds the
    // mark (ChatTabRow), each one redrew the whole card and everything on it.
    preview?: string | (() => string | undefined);
    // When the composer first held it (Conversation.draftAt); absent for a chat restored with no stamp.
    at?: number;
    // Pinned to the identity tile (its host is the tile's `relative` disc) rather than standing as a pill.
    badge?: boolean;
    // A bare glyph in the corner's stamp list, at the stamps' own size, rather than a pill or a pinned badge.
    stamp?: boolean;
}>();

// The mark reads the shared clock itself, armed only while it has a stamp to age, and quantized to the 15s that
// keeps a minute-granular age honest: a tick a second would redraw every unsent card for the same words.
const AGE_STEP_MS = 15_000;
const now = useNow(() => props.at !== undefined);
const aged = computed(() => Math.floor(now.value / AGE_STEP_MS) * AGE_STEP_MS);

const age = computed(() => (props.at === undefined ? undefined : timeAgo(props.at, { now: aged.value, days: true })));
const words = computed(() => (typeof props.preview === `function` ? props.preview() : props.preview));
// Leads with the visible word, so the pill's spoken name contains what it shows.
const spoken = computed(() => [t(`common.unsentMark.draft`), age.value, words.value].filter((part) => part !== undefined).join(`, `));
</script>

<template>
    <!-- `ring-canvas` parts the disc from the rim it overlaps, as every other badge pinned to an avatar does. -->
    <span
        v-if="badge"
        v-tooltip.top="spoken"
        role="img"
        :aria-label="spoken"
        data-unsent-mark="badge"
        class="pointer-events-auto absolute -bottom-1 -right-1 flex size-3.5 items-center justify-center rounded-full bg-canvas text-link ring-1 ring-primary-600/50"
    >
        <Icon name="pencil" class="text-3xs" />
    </span>
    <span
        v-else-if="stamp"
        v-tooltip.top="spoken"
        role="img"
        :aria-label="spoken"
        data-unsent-mark="stamp"
        class="inline-flex shrink-0 items-center text-link"
    >
        <Icon name="pencil" />
    </span>
    <!-- `w-fit` keeps it a chip in both frames: a column would stretch a flex child into a banner, a row would not. -->
    <span v-else :aria-label="spoken" data-unsent-mark="pill" class="ui-status-pill flex w-fit shrink-0 items-center bg-primary-600/15 font-semibold text-link">
        <Icon name="pencil" class="shrink-0 text-2xs" />
        {{ t(`common.unsentMark.draft`) }}
    </span>
</template>
