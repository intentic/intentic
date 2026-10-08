<!-- The app's action button: PrimeVue's, drawn in one of four tiers (button.ts), plus automatic press-locking when the `@click` handler returns a promise that outlives a beat. -->
<script setup lang="ts">
import PrimeButton from "primevue/button";
import { computed, useAttrs, useSlots } from "vue";
import Icon from "./Icon.vue";
import { type ButtonTier, type ButtonTone, primeLook } from "./button.js";
import { usePress } from "../../lib/pressLock.js";

defineOptions({ inheritAttrs: false });

const {
    tier,
    tone,
    gilded = false,
    thumb = false,
} = defineProps<{
    /** What the button IS: `loud` (one per page), `accent` (the default commit action), `boring`, `quiet`. */
    tier?: ButtonTier;
    /** A colour laid on the tier: a destructive accent button, a quiet button in the brand colour. */
    tone?: ButtonTone;
    /** The loud tier cast in the house gold, for the one action that moves the workspace up a version. */
    gilded?: boolean;
    /** A compact button a thumb has to find: 44px tall under a coarse pointer. */
    thumb?: boolean;
}>();

const attrs = useAttrs();
const slots = useSlots();
const { locked, working, press } = usePress();

// No look named at all is an installed extension's button, built before tiers existed and still passing `severity`/`text`:
// PrimeVue's own props pass through untouched, exactly as they did. A tier or a tone named here owns them instead.
const named = computed(() => tier !== undefined || tone !== undefined || gilded || thumb);
const look = computed(() => primeLook({ tier, tone, gilded, thumb }));

// `onClick` is handled here and must not be forwarded, or PrimeVue would bind it twice and double every press.
const passthrough = computed(() => {
    const { onClick: _click, disabled: _disabled, loading: _loading, ...rest } = attrs;
    if (!named.value) {
        return rest;
    }
    const { severity: _severity, text: _text, class: own, ...kept } = rest;
    return { ...kept, severity: look.value.severity, text: look.value.text, class: [look.value.class, own] };
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
            <!-- While the spinner shows: `visibility` hides the content so the button doesn't resize, and `display: contents` keeps
                 the children direct flex items. Only for that wait, so a button at rest holds its content and nothing else. -->
            <template v-if="shown">
                <span class="contents invisible"><slot /></span>
                <!-- Absolutely centred over the button so the hidden content keeps its width; `ui-press-spinner` is now only the press-lock tests' hook, not a style. -->
                <span class="ui-press-spinner absolute inset-0 flex items-center justify-center"><Icon name="spinner" spin /></span>
            </template>
            <slot v-else />
        </template>
    </PrimeButton>
</template>
