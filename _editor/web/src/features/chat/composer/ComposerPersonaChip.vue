<!-- THE ONE CONTROL ON THE COMPOSER THAT SAYS WHO THIS CHAT IS ABOUT TO ACT AS, before anybody picked. It appears
     only when the daemon has read the draft and named a card (personaRoute.ts owns that rule, and its header says
     when the reading is asked for at all). Three states, and each one's press is in its words:

       suggest — the reading is an offer. "Act as Backend?" and one press puts the card on: its accounts, its
                 repositories, its model. Nothing happens if it is left alone.
       route   — the card WILL go on when the message is sent (routing is set to auto). The chip reads
                 "→ Backend" beside the composer's persona pill that still says nothing, so the contradiction is
                 the message; one press declines it for this chat.
       held    — that press has been taken. "Everyone · Undo", and the same press lifts it.

     THE ACTION IS IN THE WORDS, not in a tooltip, for the reason the tier chip beside it gives: a control that
     narrows which accounts and repositories a chat reaches cannot be explained by hover alone. The reason the
     daemon gave rides `title` and `aria-label` as the full sentence.

     THE WHOLE CHIP IS THE PRESS, one target, and it keeps its mark at every width and drops only its words, the
     tier chip's rule: a card about to go on silently is the last thing a narrow pane should hide. The face is
     the mark: the same one the persona wears everywhere else, so the chip reads as that person arriving. -->
<script setup lang="ts">
import { PersonaFace } from "@intentic/ui";
import { computed } from "vue";
import type { PersonaRoutePreview } from "../personas/personaRoute";

const props = defineProps<{ preview: PersonaRoutePreview | undefined }>();
const emit = defineEmits<{ press: [] }>();

const name = computed(() => props.preview?.persona.label ?? props.preview?.persona.id ?? ``);

// The whole sentence, on `title` AND `aria-label`: the words on the chip name the persona, this says what is
// being done and what the press does.
const title = computed(() => {
    const state = props.preview;
    if (state === undefined) {
        return undefined;
    }
    const why = state.reason === `` ? `` : ` ${state.reason}`;
    switch (state.kind) {
        case `suggest`:
            return `This message looks like ${name.value}'s work.${why} Press to act as ${name.value}: only its accounts and repositories in reach, on its model.`;
        case `route`:
            return `When you send, this chat will act as ${name.value}.${why} Press to keep it as everyone.`;
        default:
            return `Kept as everyone rather than ${name.value}. Press to let it act as ${name.value} after all.`;
    }
});
</script>

<template>
    <button
        v-if="preview !== undefined"
        type="button"
        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
        :title="title"
        :aria-label="title"
        @click="emit(`press`)"
    >
        <PersonaFace v-if="preview.kind !== `held`" :persona="preview.persona" :size="16" />
        <Icon v-else name="lock" class="text-2xs" />
        <template v-if="preview.kind === `suggest`">
            <span class="@max-lg:hidden">Act as {{ name }}?</span>
        </template>
        <template v-else-if="preview.kind === `route`">
            <Icon name="arrow-right" class="text-2xs text-subtle" aria-hidden="true" />
            <span class="@max-lg:hidden">{{ name }}</span>
        </template>
        <template v-else>
            <span class="@max-lg:hidden">Everyone</span>
            <span class="text-subtle @max-lg:hidden" aria-hidden="true">·</span>
            <span class="text-link @max-lg:hidden">Undo</span>
        </template>
    </button>
</template>
