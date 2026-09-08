<!--
    The app's action button: PrimeVue's, unchanged, plus automatic press-locking when the `@click` handler returns a promise that outlives a beat.
    `loading`/`disabled` from outside still win. A default slot replaces the whole body, so the spinner overlays it instead of swapping the label.
-->
<script setup lang="ts">
import PrimeButton from "primevue/button";
import { computed, useAttrs, useSlots } from "vue";
import Icon from "./Icon.vue";
import { usePress } from "../../lib/pressLock.js";

defineOptions({ inheritAttrs: false });

const attrs = useAttrs();
const slots = useSlots();
const { locked, working, press } = usePress();

// `onClick` is handled here and must not be forwarded, or PrimeVue would bind it twice and double every press.
const passthrough = computed(() => {
    const { onClick: _click, disabled: _disabled, loading: _loading, ...rest } = attrs;
    return rest;
});
const listener = computed(() => attrs[`onClick`]);

// `disabled` carries the instant lock (and PrimeVue's own dimming); `loading` carries the drawn wait.
const held = computed(() => attrs[`disabled`] === true || attrs[`disabled`] === `` || locked.value);
const shown = computed(() => attrs[`loading`] === true || working.value);

// Slots pass through except `default` (wrapped for the spinner) and `loadingicon` (defaults to our own glyph).
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
            <!--
                `display: contents` keeps the children as direct flex items; `visibility` hides them so the button
                doesn't resize when the spinner appears.
            -->
            <span class="contents" :class="shown ? `invisible` : ``"><slot /></span>
            <!--
                Absolutely centred over the button so the hidden content keeps its width; `ui-press-spinner` is now
                only the press-lock tests' hook, not a style.
            -->
            <span v-if="shown" class="ui-press-spinner absolute inset-0 flex items-center justify-center"><Icon name="spinner" spin /></span>
        </template>
    </PrimeButton>
</template>
