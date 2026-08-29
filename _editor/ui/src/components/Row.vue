<!-- One row inside a <RowGroup> or a <NavRail>: an optional #lead, a title + description, a #meta cluster of
     trailing FACTS, and a #control cluster of trailing ACTIONS. #below drops full-width content beneath the
     header on the SAME row: a live preview, an expanded sub-form, so it stays inside the row's hairline
     boundary instead of spawning its own boxed inset. Set `as="label"` so a wrapped control toggles on a
     full-row click; set `interactive` (+ `chevron`) or `href` for navigational rows. Purely presentational:
     no router dependency, so internal-nav rows wrap this in the app's <RouterLink class="block">.

     #meta AND #control, not one trailing slot, because facts and actions obey different rules and every list
     that hand-wrote its rows re-derived both: a fact is muted, tabular and never focusable; an action carries
     its own hit area and tint. Splitting them is what lets this component state "facts are text-2xs text-subtle"
     once, instead of eleven callers spelling it out and drifting a shade apart.

     DENSITY IS A TIER, NOT A CLASS OVERRIDE. Three of them, because the app had independently settled on three
     and named none: settings rows breathe (`comfortable`), record lists are read in bulk (`compact`), and a
     navigator rail is scanned (`dense`). A caller reaching for `py-2` by hand is the failure this replaces:
     and the reason the record lists hand-rolled their rows even where this component was importable.

     `flush` DROPS THE PADDING, for the row whose container already owns it: the exact counterpart of
     <RowGroup>'s `flat`, and it is what lets a CARD'S MASTHEAD be this component. That masthead (an icon, an
     h2, a line of explanation, sometimes a badge or a switch on the right) is the same anatomy as a settings
     row and was hand-written on fourteen cards, which is how it ended up with five different icon treatments:
     `text-lg text-muted`, `mt-0.5 text-lg text-muted`, `mt-0.5 shrink-0 text-lg text-warning`, `text-lg
     text-success`, `text-base text-link`, and disagreed with itself about whether the icon centres on the
     block (`items-center`) or hangs off its first line (`items-start` + `mt-0.5`). The second spelling is the
     one that reads as broken: a lock nudged half a line down the left of a three-line paragraph is aligned to
     nothing, which is what "the icon looks off" turns out to mean every time it is reported.

     ONE RULE, AND IT IS `items-center`: the icon centres against the whole title-and-description block, at
     every density, padded or flush. A caller writing `mt-0.5` on a lead icon is re-opening the bug.

     A ROW THAT OPENS IS `<DisclosureRow>`, NOT THIS. It wraps this component and owns the chevron, the ARIA,
     the tint and the indent of the block below, which are the five things fourteen expandable rows had each
     answered on their own. `headerButton` below is the one hook it needed from here. Reach for this component
     directly only for a row that does not expand.

     Rounding is deliberately NOT a prop: it is the container's business, and Vue's fallthrough puts it one
     `class="rounded-md"` away for the rails that want it. -->
<script setup lang="ts">
import type { IconName } from "../icons/iconSets.js";
import Icon from "./Icon.vue";
import { ROW_TIERS as TIERS, ROW_TONES as TONES, type RowDensity, type RowTone } from "./row.js";

const {
    as = `div`,
    interactive = false,
    chevron = false,
    tone = `default`,
    density = `comfortable`,
    selected = false,
    flush = false,
    wideControl = false,
    headerButton = false,
    headlineGuard = false,
} = defineProps<{
    icon?: IconName;
    title?: string;
    description?: string;
    href?: string;
    /** `button` for a row that is PICKED (rails, selectable lists): it is what puts the row on the tab order. */
    as?: `div` | `label` | `button`;
    interactive?: boolean;
    chevron?: boolean;
    tone?: RowTone;
    /** comfortable: settings rows · compact: record lists · dense: navigator rails. */
    density?: RowDensity;
    /** Paints the app-wide selected tint. Implies `interactive`: a row you can pick is a row you can hover. */
    selected?: boolean;
    /* Renders the title as a real heading, one step up in size. A card's masthead is an `h2` in the document,
     * not a styled div, and it has to outrank the rows UNDER it on the same surface, which is the one thing
     * unifying the two costs if the size is left to the tier: masthead and option row both land on
     * `font-semibold` at the SAME size and the card reads as two titles.
     *
     * `text-lg`, not `text-base`: this app scales its type off a 17.6px root, so `text-base` IS the body size
     * and setting it changes nothing (it was written that way first, and measured as a no-op). Only the
     * `comfortable` tier leaves the size unset, and a masthead is always comfortable, so nothing collides. It
     * lands between <PageHeader>'s `text-2xl` h1 and the rows beneath it, which is the rank an h2 should read
     * at anyway. */
    heading?: 2 | 3;
    /** Turns the lead icon, for the row that IS a wait ("activating your membership"). Kept as a prop rather
     *  than left to `#lead` so a spinning row still gets the tier's size and the tone's colour for free. */
    spin?: boolean;
    /** Drops the tier's padding, for a row whose container already provides it: see the note above. */
    flush?: boolean;
    /* LETS THE TRAILING CLUSTER GIVE UP WIDTH, for the row whose control is a SET rather than a button.
     *
     * The cluster is `shrink-0` for everything else, and has to be: a size, a time or a badge squeezed to fit
     * is unreadable, and a button squeezed is unclickable, so a row with one of those in it stays as wide as
     * that fact needs and the title truncates instead. A dozen colour swatches obey the opposite rule. They
     * are one control drawn as a row of parts, each part already the size it must be, and the way it fits a
     * narrow pane is by taking a second line: the alternative is a control that pushes the row wider than the
     * pane it sits in, which is what sent it under the title in the first place.
     *
     * So the cluster takes the space LEFT OVER by the title (`basis-0 grow`) rather than claiming its own
     * width and then arguing about the shortfall. That distinction is the whole of it: made to shrink from its
     * natural width instead, flexbox divides the shortfall in proportion to base widths, so a dozen swatches
     * against one word still clip the word by a few pixels before they have wrapped once. From a zero basis
     * there is no shortfall to divide, and the title keeps its width until it is the thing that cannot fit.
     *
     * The control inside still has to be a wrapping one (`flex-wrap`) for the second line to happen. */
    wideControl?: boolean;
    /* THE LEFT REGION BECOMES ONE `<button>`: the lead, the title and the description together, with #meta and
     * #control left outside it as the separate controls they are. It exists for <DisclosureRow>, and it exists
     * because SIX files had already hand-rolled exactly this shape — the extension list, the skill list, the
     * secrets list, the machine report, the deployments board and the pipelines board — every one of them
     * because <Row> could make the WHOLE row a button (`as="button"`) or none of it, and a record row that
     * expands has trailing verbs that must not toggle it. Nesting those verbs inside a row-wide <button> is
     * invalid markup and gives the keyboard one stop where there are three actions.
     *
     * It stays PRESENTATIONAL: the button emits `headerClick` and the ARIA comes in as props. <Row> holds no
     * open/closed state and should not learn any. */
    headerButton?: boolean;
    /** `aria-expanded` for the header button. Leave unset on a header button that is not a disclosure. */
    headerExpanded?: boolean;
    /** `aria-controls` for the header button: the id of the block it opens. */
    headerControls?: string;
    /* THE HEADLINE'S CONTROLS SWALLOW THEIR OWN CLICKS — the headline BLOCK does not. For the row whose
     * headline carries a control — a turn whose label opens its transcript, a port whose sentence links to its
     * terminal, a run whose title leaves for the vendor — so that <DisclosureRow> can make the REST of the row
     * pressable without "open this" and "go somewhere else" becoming one press.
     *
     * IT USED TO SWALLOW THE WHOLE BLOCK, and that is the bug it was reported as: on the activity feed only a
     * turn WITH a transcript has a link for a title, so on every message and every loose event the biggest,
     * most obvious target on the row — its name — did nothing, and the row opened only from a 10px chevron.
     * The `pair` rows that DO carry a link were no better off: the link is a few words, and the facts line
     * under it, the preview beside it and the empty space after it were all dead on the same rule. Worse, the
     * row still painted `ui-row-select` over all of it, so the cursor and the hover wash promised a press the
     * headline had no intention of honouring — which is what "clunky" means when someone reports it.
     *
     * So the guard asks the only question that was ever being asked: DID THIS PRESS LAND ON A CONTROL. It is a
     * fact about the click, not about the block, so it cannot go stale when a caller's title stops being a
     * link — which is the exact drift the block-wide version was built to survive and did not. */
    headlineGuard?: boolean;
}>();

const emit = defineEmits<{ headerClick: [event: MouseEvent] }>();

/* THE HEADER BUTTON EATS ITS OWN CLICK. <DisclosureRow> makes the whole row pressable (the tier's padding is
 * ~40% of a comfortable row's height, and a target that stops at the text leaves a dead strip above and below
 * it), so without this the button's press and the row's press both fire and the row toggles straight back. */
const onHeaderClick = (event: MouseEvent): void => {
    if (!headerButton) {
        return;
    }
    event.stopPropagation();
    emit(`headerClick`, event);
};

/* WHAT COUNTS AS A CONTROL, for `headlineGuard`. Everything a press can mean something else on: the native
 * interactives, plus the ARIA spellings of them, because a headline's "link" is regularly a <button> and its
 * chip is regularly a <span role="button"> with a handler. A bare `[tabindex]` is deliberately NOT here — a
 * focusable text block is not a control, and a caller who wants one guarded says so with `@click.stop`. */
const HEADLINE_CONTROLS = `a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [contenteditable="true"]`;

/* See `headlineGuard`. Written out rather than as a `.stop` modifier for two reasons now: it must apply only
 * when asked, AND it must apply only to the presses that landed on a control.
 *
 * SCOPED TO THIS BLOCK with `contains`, not left to `closest` alone: `closest` walks the whole ancestor chain,
 * so in a row whose header IS a button (`hit="header"`, where this guard is off anyway) it would match that
 * button and stop the press the button itself is waiting for. The guard is about controls INSIDE the headline;
 * anything above it is the row's business. */
const onHeadlineClick = (event: MouseEvent): void => {
    if (!headlineGuard) {
        return;
    }
    const { target, currentTarget } = event;
    if (!(target instanceof Element) || !(currentTarget instanceof Element)) {
        return;
    }
    const control = target.closest(HEADLINE_CONTROLS);
    if (control !== null && currentTarget.contains(control)) {
        event.stopPropagation();
    }
};

/* A ROW YOU PICK FROM IS MUTED UNTIL YOU REACH FOR IT. All four selectable lists in the app had this rule and
 * all four spelled it themselves: the source rail, the knowledge index, the documentation contents and the log
 * file list, so a list of forty names reads as one quiet block with exactly one name lit, rather than forty
 * equally loud ones distinguished by a background wash alone.
 *
 * It keys on `as="button"` because that is already the signal for "this row is PICKED": a settings row is
 * interactive too, but its title is the thing you came to read, not one candidate among many. */
const picked = as === `button`;
</script>

<template>
    <component
        :is="href !== undefined ? `a` : as"
        :href="href"
        :target="href !== undefined ? `_blank` : undefined"
        :rel="href !== undefined ? `noopener` : undefined"
        :type="as === `button` && href === undefined ? `button` : undefined"
        :aria-current="selected ? `true` : undefined"
        class="group block w-full text-left"
        :class="[
            flush ? `` : TIERS[density].pad,
            // The app's one hover tint and one selected tint (styles/utilities.css). This used to carry
            // its own `hover:bg-content/5`: the same 5% by luck rather than by reference.
            interactive || selected || href !== undefined || as !== `div` ? `ui-row-select` : ``,
            selected ? `ui-row-select-on` : ``,
        ]"
    >
        <div class="flex items-center justify-between gap-4">
            <!-- The left region. As a `div` it is layout; as a `button` (see `headerButton`) it is the row's
                 one hit area, and it TAKES THE FREE SPACE (`flex-1`) rather than shrink-wrapping the title:
                 the gap between a short name and the trailing verbs is the easiest part of the row to aim at,
                 and a hit area that stops at the last letter of the name throws it away. -->
            <component
                :is="headerButton ? `button` : `div`"
                :type="headerButton ? `button` : undefined"
                :aria-expanded="headerButton ? headerExpanded : undefined"
                :aria-controls="headerButton ? headerControls : undefined"
                class="flex min-w-0 items-center"
                :class="[
                    TIERS[density].gap,
                    headerButton
                        ? `flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary-500`
                        : ``,
                ]"
                @click="onHeaderClick"
            >
                <slot name="lead" />
                <Icon v-if="icon !== undefined" :name="icon" :spin="spin" class="shrink-0" :class="[TIERS[density].icon, TONES[tone]]" />
                <div class="min-w-0" @click="onHeadlineClick">
                    <component
                        :is="heading === undefined ? `div` : `h${heading}`"
                        v-if="title !== undefined || $slots[`title`]"
                        class="min-w-0"
                        :class="[
                            TIERS[density].title,
                            heading === undefined ? `` : `text-lg`,
                            picked && !selected ? `text-muted group-hover:text-content` : `text-content`,
                        ]"
                    >
                        <slot name="title">{{ title }}</slot>
                    </component>
                    <p v-if="description !== undefined || $slots[`description`]" class="min-w-0 text-muted" :class="TIERS[density].description">
                        <slot name="description">{{ description }}</slot>
                    </p>
                </div>
            </component>
            <div
                v-if="$slots[`meta`] || $slots[`control`] || chevron || href !== undefined"
                class="flex items-center gap-2"
                :class="wideControl ? `grow basis-0 flex-wrap justify-end` : `shrink-0`"
            >
                <!-- Facts, not controls: tabular so a column of sizes or times lines up down the list, and muted
                     so the row's name stays the thing the eye lands on. -->
                <div v-if="$slots[`meta`]" class="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-subtle">
                    <slot name="meta" />
                </div>
                <!-- ACTIONS NEVER TOGGLE THE ROW. `display: contents` so the cluster's layout is untouched: the
                     wrapper draws no box, but it is still in the tree, so a press on a Stop button or a switch
                     stops here instead of reaching the row-wide handler <DisclosureRow> puts on this component.
                     Owned here rather than left to call sites, because "remember `@click.stop` on every control"
                     is a rule that gets remembered until it doesn't. #meta is deliberately NOT wrapped: facts
                     are not controls, and a press on one may as well open the row. -->
                <div v-if="$slots[`control`]" class="contents" @click.stop><slot name="control" /></div>
                <Icon v-if="chevron || href !== undefined" name="chevron-right" class="text-2xs text-subtle" />
            </div>
        </div>
        <div v-if="$slots[`below`]" class="mt-3">
            <slot name="below" />
        </div>
    </component>
</template>
