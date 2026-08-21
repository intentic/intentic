<!-- Design-system single-select: the replacement for native <select> / PrimeVue Select everywhere a choice
     deserves more than OS chrome: token-styled rows with icon · label · quiet description (or a wrapping hint
     sentence, for options that have to be taught rather than named) · check, group headers, wrap-around
     keyboard navigation, and a filter box that appears by itself once the list is long.
     The closed trigger is a real button (bordered `input` variant for forms/settings rows, borderless `ghost`
     for toolbars); the open panel is <ResponsiveOverlay>: anchored on desktop, a thumb-reachable sheet on a
     phone. The #icon scoped slot lets a site draw brand marks (provider logos) the icon set can't.

     THAT OVERLAY WAS EXTRACTED FROM HERE AND THIS COMPONENT KEPT THE COPY, which is the whole reason the note
     is worth writing down. <Picker> had always done the desktop/mobile swap internally, so when five other
     menus were found hand-writing the same pair they were given <ResponsiveOverlay> and this one was left
     alone: it already worked, after all. What it worked WITH was PrimeVue's Popover, and PrimeVue's Popover
     measures the room around a trigger against the module-scope `window`. In a popped-out chat or terminal
     panel that is the wrong window: the panel opens off the bottom edge with its top over the pill that owns
     it, and an overlay covering its own trigger cannot be dismissed by clicking that trigger. The app's own
     <AnchoredOverlay> exists to fix exactly that, and the design system's own picker was the last thing still
     carrying the bug. It also carried the two-boolean shape (`popoverOpen`, `sheetOpen`) that
     ResponsiveOverlay's header comment names as the thing to avoid. One flag now, and one window. -->
<script setup lang="ts" generic="T extends string">
import { twMerge } from "tailwind-merge";
import { computed, ref, useAttrs, useSlots } from "vue";
import { useDevice } from "../composables/useDevice.js";
import { normalizePickerGroups, type PickerOption, type PickerOptions } from "./picker.js";
import PersonaFace from "./PersonaFace.vue";
import PickerPanel from "./PickerPanel.vue";
import ResponsiveOverlay from "./ResponsiveOverlay.vue";

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
// py-1.5 w-full` beats the variant base the way ui.* overrides do.
const attrs = useAttrs();
const passAttrs = computed(() => {
    const { class: _class, ...rest } = attrs;
    return rest;
});
/* `touch-target` on the trigger, and it is the GHOST variant that needs it: the `input` variant already
 * clears 44px from its own padding (a form row), while the ghost one is a bare word with a caret riding a
 * toolbar: 22px tall, which is what a page's own repository switcher measured at on a phone. The overlay
 * grows the hit area on a coarse pointer and leaves the toolbar's height alone, so nothing this trigger
 * shares a row with moves. Applied to both because twMerge would drop a duplicate anyway and the input
 * variant is already big enough for the rule to be a no-op there. */
const triggerClass = computed(() =>
    twMerge(
        `touch-target inline-flex cursor-pointer select-none items-center gap-2 transition-colors disabled:cursor-default disabled:opacity-40`,
        variant === `input`
            ? `rounded-md border border-line bg-canvas px-3 py-2 text-sm text-content hover:border-line-strong focus:border-line-strong focus:outline-none`
            : `rounded-md px-1.5 py-0.5 text-xs font-medium text-content hover:bg-overlay focus:outline-none focus-visible:bg-overlay`,
        typeof attrs[`class`] === `string` ? attrs[`class`] : ``,
    ),
);

const triggerEl = ref<HTMLButtonElement | null>(null);
const open = ref(false);
// The panel never renders narrower than its trigger (a dropdown thinner than its button reads broken), with
// a floor for tiny ghost triggers whose rows still need room to breathe. Measured at the moment of opening
// rather than watched: the trigger cannot resize while a modal panel is over it.
const panelMinWidth = ref(0);

/* THE CAP HAS TO CLEAR THE FLOOR, and for a long time it did not, which was a clipping bug rather than a
 * sizing preference. The floor above lived on this sizing div; the cap (a flat `max-w-96`) lived on the panel
 * WRAPPER, one element up, inside a surface whose whole job is to clip. So a full-width form field: the
 * automations "Runs as" row is ~40rem: asked for a 40rem list inside a 24rem box, and everything at the right
 * end of every row was simply cut off: the quiet annotation, and the tick marking the current choice. The panel
 * also came out visibly narrower than the control that opened it, which is the tell.
 * One element owns both numbers now, so they cannot contradict: comfortable by default, as wide as its own
 * trigger when that is wider, and never past the edge of the window. */
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
                <!-- A face rather than a glyph when the pick is a person, because the closed trigger is the only
                     thing on screen once the panel shuts and "who is this set to" is the whole question it
                     answers. Sized to the room the trigger ALREADY has, which is the constraint that settled the
                     number: this field sits in a two-column form beside plain inputs and other pickers, and 24
                     grew it two pixels taller than all of them: a persona field visibly out of line with its
                     neighbours, to make one avatar bigger. 20 changes no height at all, and a toolbar's
                     borderless pill only has room for 16. Both are under the 28 a panel row gets, which is the
                     right way round: a list of people is where you recognise a face, and a closed field is where
                     you confirm one you have already chosen. -->
                <PersonaFace v-if="selected.face !== undefined" :persona="selected.face" :size="variant === `ghost` ? 16 : 20" />
                <Icon v-else-if="selected.icon !== undefined" :name="selected.icon" class="shrink-0 text-xs text-muted" aria-hidden="true" />
            </slot>
        </template>
        <!-- The label reveals itself only when this span actually clips it. A native `title` on the BUTTON said
             the same words the button was already showing, in the browser's own box, a second behind the rest of
             the app's hints, and stayed silent in the one case worth a hover, a name too long for the trigger. -->
        <span
            class="min-w-0 flex-1 truncate text-left"
            :class="[selected === undefined ? `text-subtle` : ``, selected?.mono === true ? `font-mono` : ``]"
            v-tooltip.bottom.overflow="selected?.label"
        >
            {{ selected?.label ?? placeholder }}
        </span>
        <Icon name="chevron-down" class="shrink-0 text-subtle" :class="variant === `ghost` ? `text-4xs` : `text-2xs`" aria-hidden="true" />
    </button>

    <ResponsiveOverlay v-model="open" :anchor="triggerEl ?? undefined" :header="header ?? ariaLabel" side="bottom" panel-class="w-max">
        <!-- The trigger-width floor is the DESKTOP panel's, and only its. A sheet is already as wide as the
             phone, and a min-width taken from a full-width trigger would push it wider than the screen. -->
        <!-- The window clamp rides the same declaration rather than a class, because an inline max-width would
             simply win over one and the panel would hang off the edge of a narrow window. -->
        <div :style="mobile ? undefined : { minWidth: `${panelMinWidth}px`, maxWidth: `min(${panelMaxWidth}px, calc(100vw - 1rem))` }">
            <PickerPanel
                :options="options"
                :selected-value="model"
                :search-threshold="searchThreshold"
                :list-label="ariaLabel"
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
