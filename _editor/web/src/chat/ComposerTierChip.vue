<!-- THE COMPOSER SAYING WHAT THE TIER JUDGE WILL SAY, before send: a small chip beside the model pill that
     appears only when the draft judges simple AND the sandbox's automatic-tier mode gives that a consequence
     (useTierPreview owns the rule). Three states, one chip:

       measure — awareness only, the whole product of the Measure mode: "this is a turn the judge would move".
                 Inert, because nothing will happen and a button that does nothing teaches people not to press.
       route   — this turn WILL run on the named cheaper model. The press is the veto: one click keeps this
                 conversation on the picked model (Conversation.tierHold), the same standing hold the picker's
                 toggle and the routed-turn notice flip.
       held    — the veto is standing and just declined a substitution. The press lifts it again.

     The chip is the pre-send half of the awareness story; the tier frame and the picker notice are the
     post-send half, and the daemon's answer always outranks this preview. -->
<script setup lang="ts">
import { computed } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { useTierPreview } from "../composables/chat/tierPreview";

const props = defineProps<{ conversation: Conversation }>();

const preview = useTierPreview(
    () => props.conversation,
    () => props.conversation.draft.value,
);

const label = computed(() => {
    const state = preview.value;
    if (state === undefined) {
        return undefined;
    }
    if (state.kind === `measure`) {
        return `Looks simple`;
    }
    return state.kind === `route` ? `Cheaper: ${state.label ?? ``}` : `My pick`;
});

const title = computed(() => {
    switch (preview.value?.kind) {
        case `measure`:
            return `Measuring: this turn looks simple enough for the cheaper tier. It still runs on your pick.`;
        case `route`:
            return `This turn looks simple, so it will run on ${preview.value.label ?? `the cheaper model`}. Click to keep your pick for this conversation.`;
        case `held`:
            return `Held: simple turns stay on your pick in this conversation. Click to allow the cheaper model again.`;
        default:
            return undefined;
    }
});

const press = (): void => {
    const state = preview.value;
    if (state?.kind === `route`) {
        props.conversation.setTierHold(true);
    } else if (state?.kind === `held`) {
        props.conversation.setTierHold(false);
    }
};
</script>

<template>
    <!-- Inert in measure mode (a span), a real button when the press means something: the distinction IS the
         affordance, a cursor that invites a click must have a click to give. -->
    <span
        v-if="preview?.kind === `measure`"
        class="composer-ghost pointer-events-none h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
        :title="title"
    >
        <Icon name="credit-card" class="text-2xs text-subtle" />
        <span class="text-subtle">{{ label }}</span>
    </span>
    <button
        v-else-if="preview !== undefined"
        type="button"
        class="composer-ghost h-8 shrink-0 gap-1.5 px-2.5 text-2xs font-medium max-md:h-11"
        :class="{ 'composer-active': preview.kind === `held` }"
        :title="title"
        :aria-label="title"
        @click="press"
    >
        <Icon name="credit-card" class="text-2xs" />
        <span>{{ label }}</span>
    </button>
</template>
