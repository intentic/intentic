<!--
    Design-system single-select replacing native <select>/PrimeVue Select: token-styled rows with icon/label/description/check, group headers, and a
    filter box once the list is long. Opens in <ResponsiveOverlay> (anchored on desktop, a sheet on phone).
-->
<script setup lang="ts" generic="T extends string">
import { twMerge } from "tailwind-merge";
import { computed, ref, useAttrs, useSlots } from "vue";
import { useDevice } from "../../composables/useDevice.js";
import { normalizePickerGroups, type PickerOption, type PickerOptions } from "./picker.js";
import PersonaFace from "../brand/PersonaFace.vue";
import PickerPanel from "./PickerPanel.vue";
import ResponsiveOverlay from "../overlays/ResponsiveOverlay.vue";

defineOptions({ inheritAttrs: false });

const {
    options,
    placeholder = `Select…`,
    disabled = false,
    variant = `input`,
    searchThreshold = 8,
    ariaLabel,
    header,
    labelClass,
} = defineProps<{
    options: PickerOptions<T>;
    placeholder?: string;
    disabled?: boolean;
    /** input: bordered form/settings trigger; ghost: borderless toolbar trigger. */
    variant?: `input` | `ghost`;
    /** Show the panel's filter box once the option count reaches this (0 = always). */
    searchThreshold?: number;
    /** Names the control for assistive tech (the trigger's text is the value, not the name). */
    ariaLabel?: string;
    /** Mobile sheet title; falls back to ariaLabel. */
    header?: string;
    /** Extra classes on every option label, in the trigger and in the panel rows. */
    labelClass?: string;
}>();

const model = defineModel<T | undefined>();
const { mobile } = useDevice();
const slots = useSlots();

const selected = computed<PickerOption<T> | undefined>(() =>
    normalizePickerGroups(options)
        .flatMap((group) => group.options)
        .find((option) => option.value === model.value),
);

// Fallthrough class lands on the trigger, twMerge'd so a caller's override beats the variant base.
const attrs = useAttrs();
const passAttrs = computed(() => {
    const { class: _class, ...rest } = attrs;
    return rest;
});
// `touch-target` mainly helps the ghost variant, whose toolbar trigger is too short to tap; a no-op on input.
const triggerClass = computed(() =>
    twMerge(
        `touch-target inline-flex cursor-pointer select-none items-center gap-2 transition-colors disabled:cursor-default`,
        /* THE BORDERED TRIGGER IS THE FIELD, not a copy of it. This used to spell the recipe out
         * (`rounded-md border border-line bg-canvas px-3 py-2 text-sm …`), which made <Picker> a second source
         * of truth for what a field looks like — and it had already drifted: no disabled fade at the app's one
         * opacity, no placeholder rule, and a focus state identical to its own hover. It wears `ui-field-box`
         * now, so a picker sitting in a form row beside a text input is the same control by construction, down
         * to the inset focus ring and the 16px mobile floor. */
        variant === `input`
            ? `ui-field-box`
            : `ui-off rounded-md px-1.5 py-0.5 text-xs font-medium text-content hover:bg-overlay focus:outline-none focus-visible:bg-overlay`,
        typeof attrs[`class`] === `string` ? attrs[`class`] : ``,
    ),
);

const triggerEl = ref<HTMLButtonElement | null>(null);
const open = ref(false);
// Panel never renders narrower than its trigger, with a floor for tiny triggers; measured once, on open.
const panelMinWidth = ref(0);

// Cap and floor are on the same element, so the max can't fall below the min and clip a wide trigger's panel.
const PANEL_WIDTH_CAP = 384; // 24rem: the comfortable reading measure for a list of names
const panelMaxWidth = computed(() => Math.max(PANEL_WIDTH_CAP, panelMinWidth.value));

const toggle = (): void => {
    if (disabled) {
        return;
    }
    if (!open.value) {
        panelMinWidth.value = Math.max(192, triggerEl.value?.offsetWidth ?? 0);
    }
    open.value = !open.value;
};

// Arrow keys open a closed picker (the native <select> gesture); once open, the panel owns the keyboard.
const openFromKey = (): void => {
    if (!open.value) {
        toggle();
    }
};

const close = (): void => {
    open.value = false;
    triggerEl.value?.focus();
};

const applyPick = (option: PickerOption<T>): void => {
    model.value = option.value;
    close();
};
</script>

<template>
    <button
        ref="triggerEl"
        v-bind="passAttrs"
        type="button"
        :class="triggerClass"
        :disabled="disabled"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-label="ariaLabel"
        @click="toggle"
        @keydown.down.prevent="openFromKey"
        @keydown.up.prevent="openFromKey"
    >
        <template v-if="selected !== undefined">
            <slot name="icon" :option="selected">
                <!--
                    A face, not a glyph, in the closed trigger too, since it's the only thing shown once the panel
                    shuts. Sized to match the trigger's row height, smaller than a panel row's face.
                -->
                <PersonaFace v-if="selected.face !== undefined" :persona="selected.face" :size="variant === `ghost` ? 16 : 20" />
                <Icon v-else-if="selected.icon !== undefined" :name="selected.icon" class="shrink-0 text-sm text-muted" aria-hidden="true" />
            </slot>
        </template>
        <!--
            Tooltip fires only on overflow; a native `title` just repeated visible text and stayed silent when
            truncated.
        -->
        <span
            class="min-w-0 flex-1 truncate text-left"
            :class="[selected === undefined ? `text-subtle` : ``, selected?.mono === true ? `font-mono` : ``, labelClass]"
            v-tooltip.bottom.overflow="selected?.label"
        >
            {{ selected?.label ?? placeholder }}
        </span>
        <Icon name="chevron-down" class="shrink-0 text-subtle" :class="variant === `ghost` ? `text-4xs` : `text-2xs`" aria-hidden="true" />
    </button>

    <ResponsiveOverlay v-model="open" :anchor="triggerEl ?? undefined" :header="header ?? ariaLabel" side="bottom" panel-class="w-max">
        <!-- Trigger-width floor applies to the desktop panel only; a mobile sheet is already phone-width. -->
        <!-- Window clamp is inline, not a class, since an inline max-width always wins the cascade. -->
        <div :style="mobile ? undefined : { minWidth: `${panelMinWidth}px`, maxWidth: `min(${panelMaxWidth}px, calc(100vw - 1rem))` }">
            <PickerPanel
                :options="options"
                :selected-value="model"
                :search-threshold="searchThreshold"
                :list-label="ariaLabel"
                :label-class="labelClass"
                :autofocus="!mobile"
                @pick="applyPick"
                @close="close"
            >
                <!-- Forward only a provided slot: an unconditional forward would override the panel's default icon. -->
                <template v-if="slots[`icon`]" #icon="slotProps"><slot name="icon" v-bind="slotProps" /></template>
            </PickerPanel>
        </div>
    </ResponsiveOverlay>
</template>
