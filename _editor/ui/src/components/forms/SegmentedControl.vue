<!-- SegmentedControl control: a row of small toggle pills for switching between a few exclusive views
     (Preview/Source, Linux/Windows, Name/Content). Active pill sits on the overlay surface; idle
     pills are muted text. Native buttons keep it keyboard-accessible without ARIA wiring. -->
<script setup lang="ts" generic="T extends string">
import type { IconName } from "../../icons/iconSets.js";
import { useDevice } from "../../composables/useDevice.js";

const {
    options,
    size = `sm`,
    stretch = false,
    wrap = false,
} = defineProps<{
    // - badge: chip with a count after the label; hidden at 0/undefined
    // - mark: an icon in that chip instead of a number, for a pending action not sized by count; wins over badge
    // - title/markTitle: hover label via v-tooltip, always on the pill, never the chip; markTitle wins with a mark
    // - icon: glyph before the label, for options with a glyph vocabulary defined elsewhere; never replaces it
    // - readonly: lets a shared preset (`as const`) spread straight into `options` without copying
    options: readonly { label: string; value: T; icon?: IconName; title?: string; badge?: number; mark?: IconName; markTitle?: string }[];
    // sm: viewer toggles; xs: cramped rows (e.g. the workspace filter bar).
    size?: `sm` | `xs`;
    // Full-width, thumb-height track for a task step on a narrow screen; compact is a mouse control elsewhere.
    stretch?: boolean;
    // Lets the row, not a pill, break when options overflow; off by default since a toolbar row is fixed-height.
    wrap?: boolean;
}>();

const model = defineModel<T>({ required: true });

// Derived from the device, not a prop, so `touch-target` applies automatically to a coarse pointer everywhere.
const { coarse } = useDevice();

// Accessible name folds the hover hint in, since a phone never sees the tooltip; always prefixed with the visible
// label, absent when there's no hint.
const nameOf = (option: { label: string; title?: string; markTitle?: string; mark?: unknown }): string | undefined => {
    const hint = (option.mark === undefined ? option.title : (option.markTitle ?? option.title))?.trim();
    return hint === undefined || hint === `` ? undefined : `${option.label} · ${hint}`;
};
</script>

<template>
    <div
        role="tablist"
        class="flex items-center"
        :class="[
            stretch ? [`w-full gap-1 rounded-lg border border-line bg-canvas`, size === `xs` ? `p-0.5` : `p-1`] : `gap-0.5`,
            wrap ? `flex-wrap gap-y-1` : ``,
        ]"
    >
        <button
            v-for="option in options"
            :key="option.value"
            type="button"
            role="tab"
            :aria-selected="model === option.value"
            :aria-label="nameOf(option)"
            v-tooltip.bottom="option.markTitle ?? option.title"
            class="cursor-pointer rounded-md font-medium transition-colors"
            :class="[
                model === option.value ? `bg-overlay text-content` : `text-muted hover:text-content`,
                // Only the compact pill needs it. The stretch track is already ≥36px and its pills sit edge to
                // edge inside a bordered box, so an overlay reaching 44px would spill past that border and
                // over the pill beside it: the one shape where a bigger hit area buys a wrong press.
                stretch ? `` : `touch-target`,
                stretch
                    ? /* THE FULL-WIDTH TRACK STILL HAS A DENSITY, which it used to ignore: `size` only reached
                       * the compact pill, so any surface wanting the track's shape was handed a thumb-sized one
                       * whether or not a thumb was ever going to press it. `sm` keeps the 36px target the setup
                       * flow's steps need on a phone; `xs` is the same track at a pointer's height, for a
                       * toggle that owns its row in a narrow column and would otherwise spend a third of that
                       * column's height saying two words. */
                      [`flex flex-1 items-center justify-center text-center`, size === `xs` ? `min-h-6 px-1.5 text-2xs` : `min-h-9 px-2 text-xs`]
                    : // A compact pill is ONE line, always. It rides fixed-height toolbar rows (.view-header is
                      // 2.25rem), so a pill that breaks doesn't merely look wrong: it stands taller than the bar
                      // holding it and than every bar beside it. Only the MARK chip could do this: an icon is an
                      // atomic inline box, so a line may break before it, where a numeric badge is plain text
                      // welded to the label with no space to break at. Nowrap also fixes the cause rather than the
                      // symptom: an unbreakable pill's min-content IS its full width, so the flex row can no
                      // longer squeeze it narrower than its own label and chip. The stretch variant keeps
                      // wrapping: it owns a full-width track with room to grow, and its labels are sentences.
                      [`whitespace-nowrap py-0.5 text-2xs`, size === `xs` ? `px-1.5` : `px-2.5`],
            ]"
            @click="model = option.value"
        >
            <Icon v-if="option.icon !== undefined" :name="option.icon" class="mr-1.5 text-sm" /><!--
            -->{{ option.label
            }}<span v-if="option.mark !== undefined" class="ml-1 rounded-full bg-primary-600/15 px-1 text-2xs text-link"
                ><Icon :name="option.mark" /></span
            ><span v-else-if="option.badge !== undefined && option.badge > 0" class="ml-1 rounded-full bg-primary-600/15 px-1 text-2xs text-link">{{
                option.badge > 99 ? `99+` : option.badge
            }}</span>
        </button>
    </div>
</template>
