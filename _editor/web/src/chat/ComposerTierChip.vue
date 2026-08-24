<!-- THE ONE CONTROL ON THE COMPOSER THAT SAYS YOUR MODEL IS ABOUT TO BE SWAPPED, and the press that stops it.
     It appears only when a swap is really going to happen (useTierPreview owns that rule, and its header says
     why Measure mode now draws nothing at all). Two states:

       route — this turn WILL run on the named cheaper model. The chip reads "→ Haiku 4.5" beside a pill that
               says "Opus 4.5", so the contradiction is the message: something is replacing your pick. One
               press keeps the pick for this conversation (Conversation.tierHold).
       held  — that press has been taken, or a hold from an earlier turn is standing, and it is declining a
               swap right now. The chip reads "Kept on Opus 4.5 · Undo" and the same press lifts it.

     THE ACTION IS IN THE WORDS, not in a tooltip. The old chip's entire explanation lived in `title`: delayed
     on a mouse, absent on a touch screen, unreachable from a keyboard, and gone the moment the pane narrowed.
     A control that quietly substitutes the model you chose cannot be explained by hover alone, so the held
     state spells its press out ("Undo") and both states carry the full sentence on `aria-label` as well as
     `title`. Ghost styling in both, not the row's lit `composer-active`: the accent is spent on the action
     word, because that word is what makes this legible.

     THE WHOLE CHIP IS THE PRESS, including the "Undo". One target rather than a word-sized one inside a pill
     that is already only 32px tall — and the trailing word then reads as the label of the thing under the
     cursor, which is exactly what it is.

     IT NEVER DISAPPEARS WITH THE PANE, only its words do. The composer's other controls hide their LABEL on a
     narrow pane and keep their mark, and this one has more reason to than any of them: a width that hid it
     would make a substitution silent on exactly the layout (a split pane, a phone) where the model row is
     hardest to read. The icon carries the state on its own — an arrow for a swap, a lock for a hold. -->
<script setup lang="ts">
import { computed } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { useTierPreview } from "../composables/chat/tierPreview";

const props = defineProps<{ conversation: Conversation }>();

const preview = useTierPreview(
    () => props.conversation,
    () => props.conversation.draft.value,
);

/* The whole sentence, on `title` AND `aria-label`, because the chip's own words are deliberately short enough
 * to fit a composer row: they name the models, this names what is being done to them and what the press does. */
const title = computed(() => {
    const state = preview.value;
    if (state === undefined) {
        return undefined;
    }
    return state.kind === `route`
        ? `This turn looks simple, so it runs on ${state.cheap} instead of ${state.pick}. Press to keep ${state.pick} for this chat.`
        : `Simple turns are kept on ${state.pick} in this chat. Press to let them run on ${state.cheap} again.`;
});

// One press, both directions: it is the same standing veto the picker's toggle and the routed-turn notice flip.
const press = (): void => {
    const state = preview.value;
    if (state !== undefined) {
        props.conversation.setTierHold(state.kind === `route`);
    }
};
</script>

<template>
    <button
        v-if="preview !== undefined"
        type="button"
        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
        :title="title"
        :aria-label="title"
        @click="press"
    >
        <Icon :name="preview.kind === `route` ? `arrow-right` : `lock`" class="text-2xs" />
        <!-- The words go on a narrow pane, the mark stays: see the note at the top of this file for why this
             control in particular must never vanish with the width. -->
        <template v-if="preview.kind === `route`">
            <span class="@max-lg:hidden">{{ preview.cheap }}</span>
        </template>
        <template v-else>
            <span class="@max-lg:hidden">Kept on {{ preview.pick }}</span>
            <span class="text-subtle @max-lg:hidden" aria-hidden="true">·</span>
            <span class="text-link @max-lg:hidden">Undo</span>
        </template>
    </button>
</template>
