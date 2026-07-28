<!-- Design-system single-select — the replacement for native <select> / PrimeVue Select everywhere a choice
     deserves more than OS chrome: token-styled rows with icon · label · quiet description · check, group
     headers, wrap-around keyboard navigation, and a filter box that appears by itself once the list is long.
     The closed trigger is a real button (bordered `input` variant for forms/settings rows, borderless `ghost`
     for toolbars); the open panel is a Popover on desktop and a BottomSheet on mobile — the app's standard
     touch swap. The #icon scoped slot lets a site draw brand marks (provider logos) the icon set can't. -->
<script setup lang="ts" generic="T extends string">
import Popover from "primevue/popover";
import { twMerge } from "tailwind-merge";
import { computed, ref, useAttrs, useSlots } from "vue";
import { useDevice } from "../composables/useDevice.js";
import { normalizePickerGroups, type PickerOption, type PickerOptions } from "./picker.js";
import BottomSheet from "./BottomSheet.vue";
import PickerPanel from "./PickerPanel.vue";

defineOptions({ inheritAttrs: false });

const {
    options,
    placeholder = `Select…`,
    disabled = false,
    variant = `input`,
    searchThreshold = 8,
    ariaLabel,
    header,
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
}>();

const model = defineModel<T | undefined>();
const { mobile } = useDevice();
const slots = useSlots();

const selected = computed<PickerOption<T> | undefined>(() =>
    normalizePickerGroups(options)
        .flatMap((group) => group.options)
        .find((option) => option.value === model.value),
);

// Class fallthrough lands on the trigger (the component's one element), twMerge'd so a caller's `text-xs
// py-1.5 w-full` beats the variant base the way cmp.* overrides do.
const attrs = useAttrs();
const passAttrs = computed(() => {
    const { class: _class, ...rest } = attrs;
    return rest;
});
const triggerClass = computed(() =>
    twMerge(
        `inline-flex cursor-pointer select-none items-center gap-2 transition-colors disabled:cursor-default disabled:opacity-40`,
        variant === `input`
            ? `rounded-md border border-line bg-canvas px-3 py-2 text-sm text-content hover:border-line-strong focus:border-line-strong focus:outline-none`
            : `rounded-md px-1.5 py-0.5 text-xs font-medium text-content hover:bg-overlay focus:outline-none focus-visible:bg-overlay`,
        typeof attrs[`class`] === `string` ? attrs[`class`] : ``,
    ),
);

const popover = ref<InstanceType<typeof Popover>>();
const triggerEl = ref<HTMLButtonElement | null>(null);
const popoverOpen = ref(false);
const sheetOpen = ref(false);
// The panel never renders narrower than its trigger (a dropdown thinner than its button reads broken), with
// a floor for tiny ghost triggers whose rows still need room to breathe.
const panelMinWidth = ref(0);

const toggle = (event: Event): void => {
    if (disabled) {
        return;
    }
    if (mobile.value) {
        sheetOpen.value = !sheetOpen.value;
        return;
    }
    panelMinWidth.value = Math.max(192, triggerEl.value?.offsetWidth ?? 0);
    popover.value?.toggle(event);
};

// Arrow keys open a closed picker (the native <select> gesture); once open, the panel owns the keyboard.
const openFromKey = (event: Event): void => {
    if (!popoverOpen.value && !sheetOpen.value) {
        toggle(event);
    }
};

const applyPick = (option: PickerOption<T>): void => {
    model.value = option.value;
    sheetOpen.value = false;
    popover.value?.hide();
    triggerEl.value?.focus();
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
        :aria-expanded="popoverOpen || sheetOpen"
        :aria-label="ariaLabel"
        :title="selected?.label"
        @click="toggle"
        @keydown.down.prevent="openFromKey"
        @keydown.up.prevent="openFromKey"
    >
        <template v-if="selected !== undefined">
            <slot name="icon" :option="selected">
                <Icon v-if="selected.icon !== undefined" :name="selected.icon" class="shrink-0 text-xs text-muted" aria-hidden="true" />
            </slot>
        </template>
        <span class="min-w-0 flex-1 truncate text-left" :class="[selected === undefined ? `text-subtle` : ``, selected?.mono === true ? `font-mono` : ``]">
            {{ selected?.label ?? placeholder }}
        </span>
        <Icon name="chevron-down" class="shrink-0 text-subtle" :class="variant === `ghost` ? `text-[0.5rem]` : `text-2xs`" aria-hidden="true" />
    </button>

    <BottomSheet v-if="mobile" v-model="sheetOpen" :header="header ?? ariaLabel">
        <PickerPanel
            :options="options"
            :selected-value="model"
            :search-threshold="searchThreshold"
            :list-label="ariaLabel"
            @pick="applyPick"
            @close="sheetOpen = false"
        >
            <!-- Forward only a provided slot: an unconditional forward would override the panel's default icon. -->
            <template v-if="slots[`icon`]" #icon="slotProps"><slot name="icon" v-bind="slotProps" /></template>
        </PickerPanel>
    </BottomSheet>
    <Popover v-else ref="popover" :pt="{ content: { class: `!p-0` } }" @show="popoverOpen = true" @hide="popoverOpen = false">
        <div class="w-max max-w-96" :style="{ minWidth: `${panelMinWidth}px` }">
            <PickerPanel
                :options="options"
                :selected-value="model"
                :search-threshold="searchThreshold"
                :list-label="ariaLabel"
                autofocus
                @pick="applyPick"
                @close="popover?.hide()"
            >
                <template v-if="slots[`icon`]" #icon="slotProps"><slot name="icon" v-bind="slotProps" /></template>
            </PickerPanel>
        </div>
    </Popover>
</template>
