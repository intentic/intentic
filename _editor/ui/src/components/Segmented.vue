<!-- Segmented control: a row of small toggle pills for switching between a few exclusive views
     (Preview/Source, Linux/Windows, Name/Content). Active pill sits on the overlay surface; idle
     pills are muted text. Native buttons keep it keyboard-accessible without ARIA wiring. -->
<script setup lang="ts" generic="T extends string">
import type { IconName } from "../icons/iconSets.js";

const {
    options,
    size = `sm`,
    stretch = false,
    wrap = false,
} = defineProps<{
    // badge: a small count chip after the label (e.g. unreviewed changes on a tab); hidden at 0/undefined.
    // mark: an icon in that same chip INSTEAD of a number, for a pending action whose size is not what the user
    // acts on (committed work still to push). Takes precedence — one chip states one thing.
    // title / markTitle: the pill's hover label, raised through `v-tooltip` like every other hint in the app — a
    // native `title=` looked nothing like the rest and sat behind the browser's ~1s delay. BOTH ride the PILL,
    // never the chip inside it: a tooltip on a descendant of a tooltipped element opens a second box on top of
    // the first (see tooltip.ts, rule 5). markTitle wins while there is a mark, on the same "one chip states one
    // thing" reasoning. Leave title out where the label already says it — a segmented control's whole point is
    // that its options are readable.
    // The array is `readonly` so a shared preset can be declared `as const` / `readonly` at its source and
    // spread straight in (TIME_WINDOWS is, and every feed that shows it would otherwise need a copy).
    options: readonly { label: string; value: T; title?: string; badge?: number; mark?: IconName; markTitle?: string }[];
    // sm: viewer toggles; xs: cramped rows (e.g. the workspace filter bar).
    size?: `sm` | `xs`;
    /* The control OWNS its row rather than trailing a toolbar: equal-width pills across the full width, in a
     * framed track, at a height a thumb can hit. Reach for it when the choice is a step of the task on a
     * narrow screen (setup's Linux / Windows / Compose), not when it is a viewer toggle sitting in a header.
     * The compact default is deliberate everywhere else: at ~20px tall it is a mouse control, and on a phone
     * its labels wrap to two lines each and the row stops reading as one control at all. */
    stretch?: boolean;
    /* Lets the ROW break between pills when the options outrun the container — the pill itself stays one line
     * either way. Off by default because the compact control mostly rides fixed-height toolbar rows, where a
     * second line would stand taller than the bar holding it; on for pickers sitting in a form column, where
     * the option list is data-driven (a sandbox's identities) and an unwrapping row would run off the edge
     * with its later options unreachable. */
    wrap?: boolean;
}>();

const model = defineModel<T>({ required: true });
</script>

<template>
    <div role="tablist" class="flex items-center" :class="[stretch ? `w-full gap-1 rounded-lg border border-line bg-canvas p-1` : `gap-0.5`, wrap ? `flex-wrap gap-y-1` : ``]">
        <button
            v-for="option in options"
            :key="option.value"
            type="button"
            role="tab"
            :aria-selected="model === option.value"
            v-tooltip.bottom="option.markTitle ?? option.title"
            class="cursor-pointer rounded-md font-medium transition-colors"
            :class="[
                model === option.value ? `bg-overlay text-content` : `text-muted hover:text-content`,
                stretch
                    ? `flex min-h-9 flex-1 items-center justify-center px-2 text-center text-xs`
                    : // A compact pill is ONE line, always. It rides fixed-height toolbar rows (.view-header is
                      // 2.25rem), so a pill that breaks doesn't merely look wrong — it stands taller than the bar
                      // holding it and than every bar beside it. Only the MARK chip could do this: an icon is an
                      // atomic inline box, so a line may break before it, where a numeric badge is plain text
                      // welded to the label with no space to break at. Nowrap also fixes the cause rather than the
                      // symptom — an unbreakable pill's min-content IS its full width, so the flex row can no
                      // longer squeeze it narrower than its own label and chip. The stretch variant keeps
                      // wrapping: it owns a full-width track with room to grow, and its labels are sentences.
                      [`whitespace-nowrap py-0.5 text-2xs`, size === `xs` ? `px-1.5` : `px-2.5`],
            ]"
            @click="model = option.value"
        >
            {{ option.label
            }}<span v-if="option.mark !== undefined" class="ml-1 rounded-full bg-primary-600/15 px-1 text-2xs text-link"
                ><Icon :name="option.mark" /></span
            ><span v-else-if="option.badge !== undefined && option.badge > 0" class="ml-1 rounded-full bg-primary-600/15 px-1 text-2xs text-link">{{
                option.badge > 99 ? `99+` : option.badge
            }}</span>
        </button>
    </div>
</template>
