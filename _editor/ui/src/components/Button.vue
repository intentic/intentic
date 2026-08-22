<!-- THE APP'S ACTION BUTTON. PrimeVue's underneath, unchanged in every pixel, plus the one behaviour a bare
     button cannot have: it knows when the press it just took started work that has not finished.

     Nothing at a call site has to opt in. `<Button @click="save">` where `save` returns a promise is now a
     button that locks the moment it is pressed and shows itself working if the wait outlives a beat; the same
     tag where the handler returns nothing behaves exactly as it always did. That is the point of putting it
     here rather than behind a `busy` prop: a prop is a thing three hundred call sites can forget, and the ones
     that forget are the ones whose action was slow enough for it to matter.

     WHY IT READS THE LISTENER OFF ATTRS. A promise is the only honest signal that a press is still being
     answered, and `@click` throws it away. Taking the listener as an attr and calling it ourselves is what
     lets the button see the return value; everything else about it falls through to PrimeVue untouched.

     `loading` and `disabled` still work from outside, and they win: a caller already tracking its own busy
     state (a form that disables its whole footer) keeps saying so, and this only adds to it.

     THE SPINNER HAS TWO SPELLINGS, because PrimeVue's button has two bodies.

     With `label` and `#icon` — the house pattern, and most of the app — PrimeVue's own loading state puts the
     spinner where the icon goes and keeps the word, which is exactly right, and is what the handful of call
     sites already driving `:loading` themselves have always looked like. The glyph is ours rather than
     PrimeVue's so the two spellings spin the same mark. A labelled button with no icon grows by the spinner's
     width when it appears; that is the framework's own behaviour and it is left alone rather than reproduced
     by hand, because the alternative is a second copy of `p-button-label` for this file to keep in step.

     With a default slot, that slot replaces the button's whole body, spinner included, so PrimeVue would draw
     nothing at all. There the spinner is hung over the middle of the button and the content hidden in place,
     which also keeps the button's exact width: those are the answers on a decision card, sitting in a row of
     two or three, and one of them resizing would shift the others out from under the cursor. -->
<script setup lang="ts">
import PrimeButton from "primevue/button";
import { computed, useAttrs, useSlots } from "vue";
// Imported rather than taken off the global registration every other file leans on: this is the one component
// in the kit that a test is likely to mount WITHOUT installUi having run, and a compiled template resolves its
// components whether or not the branch holding them is drawn.
import Icon from "./Icon.vue";
import { usePress } from "../lib/pressLock.js";

defineOptions({ inheritAttrs: false });

const attrs = useAttrs();
const slots = useSlots();
const { locked, working, press } = usePress();

// `onClick` is handled here, so it must not also be forwarded: PrimeVue would bind it a second time and every
// press would run the handler twice. `disabled` and `loading` come back below, widened by our own state.
const passthrough = computed(() => {
    const { onClick: _click, disabled: _disabled, loading: _loading, ...rest } = attrs;
    return rest;
});
const listener = computed(() => attrs[`onClick`]);

/* The caller's own state, kept and added to rather than replaced. `disabled` carries the instant lock, and is
 * also where the dimming comes from: PrimeVue's disabled opacity, the same one every disabled control in the
 * app already wears. `loading` carries the drawn wait. */
const held = computed(() => attrs[`disabled`] === true || attrs[`disabled`] === `` || locked.value);
const shown = computed(() => attrs[`loading`] === true || working.value);

/* Slots go straight through, except the two this owns: the default one is wrapped so the spinner has
 * something to hang over (see the header), and `loadingicon` is filled in with the kit's own glyph unless the
 * caller brought one, so both spellings of the wait spin the same mark. */
const wrapped = computed(() => slots[`default`] !== undefined);
const OWN = new Set([`default`, `loadingicon`]);
const forwarded = computed(() => Object.keys(slots).filter((name) => !OWN.has(name)));
const ownSpinner = computed(() => slots[`loadingicon`] === undefined);
</script>

<template>
    <PrimeButton v-bind="passthrough" :disabled="held" :loading="shown" :class="wrapped ? `relative` : ``" @click="press(listener, $event)">
        <template v-for="name in forwarded" #[name]="slotProps" :key="name"><slot :name="name" v-bind="slotProps ?? {}" /></template>
        <template v-if="ownSpinner" #loadingicon><Icon name="spinner" spin /></template>
        <template v-else #loadingicon="slotProps"><slot name="loadingicon" v-bind="slotProps ?? {}" /></template>
        <template v-if="wrapped" #default>
            <!-- `display: contents` so the caller's children stay direct flex items of the button and keep its
                 gap; `visibility` is what hides them, so the box they occupy survives and the button does not
                 change size when the spinner arrives. -->
            <span class="contents" :class="shown ? `invisible` : ``"><slot /></span>
            <span v-if="shown" class="ui-press-spinner"><Icon name="spinner" spin /></span>
        </template>
    </PrimeButton>
</template>

<style scoped>
/* Over the middle of the button, out of flow, so the hidden content underneath keeps the width it had. The
   root carries `relative` for this and nothing else; PrimeVue's own root sets no position. */
.ui-press-spinner {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
}
</style>
