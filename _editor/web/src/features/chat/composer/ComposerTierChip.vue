<!--
    Composer control naming an automatic model swap for this turn, shown only when useTierPreview decides one will happen. Two states: route (swap
    will happen; press holds the current model for this conversation), held (a hold is active; press lifts it) — spelled out in the label and
    `aria-label`, never a tooltip. Keeps its mark and drops only its words on a narrow pane.
-->
<script setup lang="ts">
import { computed } from "vue";
import type { Conversation } from "../session/conversation";
import { useTierPreview } from "../models/tierPreview";

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
