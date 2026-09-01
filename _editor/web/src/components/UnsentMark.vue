<script setup lang="ts">
import { computed } from "vue";
import { relativeTime } from "../composables/chat/catalog";

/* WORDS OF THE USER'S STILL SITTING IN A CHAT'S COMPOSER (Conversation.unsent). Everything else on a session
 * card is the agent's account of itself; this is the reader's own unfinished business, and the only thing on
 * either surface that nobody but them can clear. It is also why such a card is on the board at all — an ARCHIVED
 * session is lifted back onto the lanes for it (useAgents.fleet) — so a card that came back without saying why
 * would read as the archive leaking.
 *
 * ONE COMPONENT BECAUSE IT IS ONE FACT. It is read on the fleet board's card (AgentCard) and on the chat rail's
 * row (ChatTabList), minutes apart by the same eye, and for as long as each drew its own the two drifted: a bare
 * line of link-coloured text over there, a filled chip over here, one saying "Unsent message" and the other
 * "Unsent". The same fact in two shapes, with nothing to tell the reader they meant the same thing.
 *
 * A CHIP, NEVER A LONE GLYPH. The rail wore a bare paper plane once: findable when you already knew it was
 * there, invisible while skimming, which is exactly when a half-written message gets lost. The composer's own
 * send glyph, in the link hue this app spends on "an offer to act": nothing is wrong here, so none of the
 * warning colours apply.
 *
 * THE WORDS THEMSELVES ARE ON THE HOVER AND NEVER ON THE FACE. A board is read at a glance and often over
 * somebody's shoulder, and a half-written message is the most private thing this app holds. But a label can only
 * ever say THAT one exists, while what the reader decides on is which message it is and how long it has been
 * standing — a sentence broken off a minute ago and one abandoned four days back wear the identical mark. So the
 * hover carries both. That is also what the hover is FOR, and what it was not doing: it used to answer "Unsent
 * message" with "You have an unsent message here", the same sentence twice.
 *
 * IT OPENS DOWNWARDS, because the mark sits directly under a title in both frames and a hint above it lands on
 * that title: the reader hovers to learn WHICH unsent message this is and the answer covers the name of the
 * session it belongs to. Below the mark is the meta line (model, origin, age) — facts the hint's own two lines
 * are worth more than for the second they hide them. On the rail it also clears the row's HoverCard, which
 * opens to the right off the same hover and would otherwise be argued with mid-air. */

const props = defineProps<{
    /* The message's opening words (draftPreview, at most a line of them). Absent when what is unsent is an
     * attachment or a message queued behind a running turn rather than typed text — the mark is true either way,
     * and its hover simply stops naming what is in there. */
    preview?: string;
    // When the composer first held it (Conversation.draftAt), which is the age the hover reports. Absent on a
    // chat restored from a snapshot that carried no stamp.
    at?: number;
    /* The host's tick, from a surface that has one (AgentsView's `now`, the rail's useNow). Less an argument to
     * the age than a DEPENDENCY of it: this mark's props are as still as the draft is, so with nothing to
     * re-render on it would go on answering with the age it was first built with, "just now" an hour later.
     * Optional, because a surface without a clock still renders a correct age on every render it does do. */
    now?: number;
}>();

/* The whole of what the reader does not already have on the card, in the house's clause-comma-clause voice
 * ("Worked since you last opened it, 12m"). Each part is dropped rather than faked when it is missing, and with
 * both gone the hint falls back to naming the state plainly: a chip reading "Unsent" over a tooltip reading
 * "Unsent" is worse than a chip with no tooltip, so the floor has to say something the face does not. */
const hint = computed<string>(() => {
    const age = props.at === undefined ? undefined : relativeTime(props.at, props.now);
    if (props.preview !== undefined) {
        return age === undefined ? `Not sent: ${props.preview}` : `Not sent, ${age}: ${props.preview}`;
    }
    return age === undefined ? `You have an unsent message here` : `Not sent, ${age}`;
});
</script>

<template>
    <!-- `w-fit` is what keeps it a chip in BOTH frames. The board stacks its card's blocks in a column, where a
         flex child stretches across the cross axis and a chip that took the width would read as a banner; the
         rail lays the same blocks along a row, where the cross axis is height and this costs nothing. -->
    <span
        v-tooltip.bottom="hint"
        :aria-label="hint"
        class="flex w-fit shrink-0 items-center gap-1 rounded-full bg-primary-600/15 py-px pl-1.5 pr-2.5 text-2xs font-semibold text-link"
    >
        <Icon name="send" class="shrink-0 text-2xs" />
        Unsent
    </span>
</template>
