import { tv } from "tailwind-variants";

/* SegmentedControl's two parts, the track and an option, as one recipe with slots: its four axes (variant, stretch,
   size, selected) used to be a nested ternary in the template, and a nested ternary is where a combination nobody
   drew goes unnoticed. The underline variant's option is `ui.tab()`, which owns the tab everywhere else too. */
export const segmented = tv({
    slots: {
        track: `flex items-center`,
        option: `cursor-pointer transition-colors`,
    },
    variants: {
        // - pills: a track of toggles, for switching a view INSIDE a panel that keeps its own frame.
        // - underline: tabs with no track at all, for the switch that says what a whole column or pane IS. No fill, no
        //   radius and no inset: the tabs sit flush with whatever hosts them, so a tab's label lines up with the left
        //   edge of whatever is stacked under it. `gap-4`, because with nothing boxing a tab, the space beside it is
        //   all that separates the two.
        variant: { pills: { option: `rounded-md font-medium` }, underline: { track: `gap-4` } },
        // Full-width, thumb-height track for a task step on a narrow screen (pills only).
        stretch: { true: {}, false: {} },
        size: { sm: {}, xs: {} },
        active: { true: {}, false: {} },
        // Lets the row, not a pill, break when options overflow; off by default since a toolbar row is fixed-height.
        wrap: { true: { track: `flex-wrap gap-y-1` } },
    },
    compoundVariants: [
        { variant: `pills`, active: true, class: { option: `ui-pill-on` } },
        { variant: `pills`, active: false, class: { option: `text-muted hover:text-content` } },
        // A compact pill is ONE line, always. It rides fixed-height toolbar rows (.view-header is 2.25rem), so a pill
        // that breaks doesn't merely look wrong: it stands taller than the bar holding it and than every bar beside it.
        // Nowrap also fixes the cause rather than the symptom: an unbreakable pill's min-content IS its full width, so
        // the flex row can no longer squeeze it narrower than its own label and chip. Only the compact pill takes
        // `touch-target`: the stretch track is already ≥36px and its pills sit edge to edge inside a bordered box, so
        // an overlay reaching 44px would spill past that border and over the pill beside it.
        { variant: `pills`, stretch: false, class: { track: `gap-0.5`, option: `touch-target whitespace-nowrap py-0.5 text-2xs` } },
        { variant: `pills`, stretch: false, size: `sm`, class: { option: `px-2.5` } },
        { variant: `pills`, stretch: false, size: `xs`, class: { option: `px-1.5` } },
        // The stretch variant keeps wrapping: it owns a full-width track with room to grow, and its labels are sentences.
        {
            variant: `pills`,
            stretch: true,
            class: { track: `w-full gap-1 rounded-lg border border-line bg-canvas`, option: `flex flex-1 items-center justify-center text-center` },
        },
        { variant: `pills`, stretch: true, size: `sm`, class: { track: `p-1`, option: `min-h-9 px-2 text-xs` } },
        { variant: `pills`, stretch: true, size: `xs`, class: { track: `p-0.5`, option: `min-h-6 px-1.5 text-2xs` } },
    ],
    defaultVariants: { variant: `pills`, stretch: false, size: `sm`, active: false },
});
