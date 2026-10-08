<!-- SegmentedControl control: a row of small toggle pills for switching between a few exclusive views (Preview/Source, Linux/Windows, Name/Content). -->
<script setup lang="ts" generic="T extends string">
import type { IconName } from "../../icons/iconSets.js";
import { useDevice } from "../../composables/useDevice.js";
import { computed } from "vue";
import { ui } from "../../lib/ui.js";
import { segmented } from "./segmented.js";
import { countBadgePlate, countBadgeText } from "../feedback/countBadge.js";
import { tipText } from "../../lib/tipText.js";
import type { TooltipValue } from "../../lib/tooltip.js";

const {
    options,
    size = `sm`,
    variant = `pills`,
    stretch = false,
    wrap = false,
} = defineProps<{
    // - badge: chip with a count after the label; hidden at 0/undefined
    // - mark: an icon in that chip instead of a number, for a pending action not sized by count; wins over badge
    // - markSpin: turns that icon, for a mark that stands for work happening right now rather than one waiting
    // - title/markTitle: hover label via v-tooltip, always on the pill, never the chip; markTitle wins with a mark
    // - icon: glyph before the label, for options with a glyph vocabulary defined elsewhere; never replaces it
    // - hue: identity accent as a dot before the label, for an option that stands for a PERSON rather than a view;
    //   the caller passes the number so the hue stays one rule in the app (identityHue) rather than two
    // - readonly: lets a shared preset (`as const`) spread straight into `options` without copying
    options: readonly {
        label: string;
        value: T;
        icon?: IconName;
        hue?: number;
        title?: TooltipValue;
        badge?: number;
        mark?: IconName;
        markSpin?: boolean;
        markTitle?: TooltipValue;
    }[];
    // sm: viewer toggles; xs: cramped rows (e.g. the workspace filter bar).
    size?: `sm` | `xs`;
    // - pills: a track of toggles, for switching a view INSIDE a panel that keeps its own frame.
    // - underline: tabs with no track at all, for the switch that says what a whole column or pane IS. Reach for it
    //   where the control would otherwise stack a second bordered box on a surface that already has one.
    // `stretch` is a pills-only shape; underline sizes itself to its labels, since a tab reads as a heading.
    variant?: `pills` | `underline`;
    // Full-width, thumb-height track for a task step on a narrow screen; compact is a mouse control elsewhere.
    stretch?: boolean;
    // Lets the row, not a pill, break when options overflow; off by default since a toolbar row is fixed-height.
    wrap?: boolean;
}>();

const model = defineModel<T>({ required: true });

// Derived from the device, not a prop, so a coarse pointer is served everywhere without a call site opting in. The
// pill leaves it to `touch-target`'s CSS overlay; the underline tab reads this and grows for real (see below).
const { coarse } = useDevice();

// Accessible name folds the hover hint in, since a phone never sees the tooltip; always prefixed with the visible
// label, absent when there's no hint.
const nameOf = (option: { label: string; title?: TooltipValue; markTitle?: TooltipValue; mark?: unknown }): string | undefined => {
    const hint = tipText(option.mark === undefined ? option.title : (option.markTitle ?? option.title));
    return hint === undefined ? undefined : `${option.label} · ${hint}`;
};

// Square-ish at one digit and a lozenge past that, like the rail's; `tabular-nums` so a ticking count doesn't
// shuffle the pill's width under the pointer. Sized a step below the label (3xs, 1.35em ⇒ 13.5px) so it sits INSIDE
// the pill's 16px line box: at the label's own size it filled that box edge to edge and read as a second control
// rather than a count on one. The rail's is bigger because it floats in a tile's corner, owing no line its height.
const CHIP = `ml-1 inline-flex h-[1.35em] min-w-[1.35em] items-center justify-center rounded-full px-[0.3em] text-3xs font-semibold leading-none tabular-nums`;

// One step up the type scale from the pill of the same `size`, deliberately: a pill labels a control, where a tab
// names what the reader is looking at, and at the pill's size it read as a control that had lost its box. The
// padding is under the label only — the rule has to clear the descenders without floating away from the word.
//
// Real height on a coarse pointer, NOT `touch-target`: that overlay is centred on its element, so on a 24px tab it
// reaches 10px past the strip and takes presses meant for whatever sits under it (in the chat rail, the filter
// field 6px below). `items-end` spends the extra height upward, so the label keeps its rule and the target grows
// into the header's own margin instead.
const underlineTab = (active: boolean): string =>
    ui.tab(active, coarse.value ? `flex min-h-11 items-end` : ``, size === `xs` ? `pb-1.5 text-xs` : `pb-2 text-sm`);

const look = computed(() => segmented({ variant, stretch: variant === `pills` && stretch, size, wrap }));
const optionClass = (active: boolean): string => (variant === `underline` ? underlineTab(active) : look.value.option({ active }));
</script>

<template>
    <div role="tablist" :class="look.track()">
        <button
            v-for="option in options"
            :key="option.value"
            type="button"
            role="tab"
            :aria-selected="model === option.value"
            :aria-label="nameOf(option)"
            v-tooltip.bottom="option.markTitle ?? option.title"
            :class="optionClass(model === option.value)"
            @click="model = option.value"
        >
            <Icon v-if="option.icon !== undefined" :name="option.icon" class="mr-1.5 text-sm" /><!--
            The same fill Avatar gives a person, shrunk to what a pill can carry: no face, just enough colour to tie
            this option to the marks it filters to.
         --><span
                v-else-if="option.hue !== undefined"
                class="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                :style="{ backgroundColor: `hsl(${option.hue} 55% 52%)` }"
            /><!--
            -->{{ option.label }}<!--
            The same plate the rail and the phone tab bar draw a count on (countBadge.ts), minus their ring: those
            overlap the glyph they badge and need separating from it, where this one sits beside a label.
         --><span v-if="option.mark !== undefined" :class="[CHIP, countBadgePlate()]"
                ><Icon :name="option.mark" :spin="option.markSpin === true" /></span
            ><span v-else-if="option.badge !== undefined && option.badge > 0" :class="[CHIP, countBadgePlate()]">{{
                countBadgeText(option.badge)
            }}</span>
        </button>
    </div>
</template>
