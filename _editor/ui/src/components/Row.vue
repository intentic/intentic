<!-- One row inside a <RowGroup> or a <NavRail>: an optional #lead, a title + description, a #meta cluster of
     trailing FACTS, and a #control cluster of trailing ACTIONS. #below drops full-width content beneath the
     header on the SAME row — a live preview, an expanded sub-form — so it stays inside the row's hairline
     boundary instead of spawning its own boxed inset. Set `as="label"` so a wrapped control toggles on a
     full-row click; set `interactive` (+ `chevron`) or `href` for navigational rows. Purely presentational —
     no router dependency, so internal-nav rows wrap this in the app's <RouterLink class="block">.

     #meta AND #control, not one trailing slot, because facts and actions obey different rules and every list
     that hand-wrote its rows re-derived both: a fact is muted, tabular and never focusable; an action carries
     its own hit area and tint. Splitting them is what lets this component state "facts are text-2xs text-subtle"
     once, instead of eleven callers spelling it out and drifting a shade apart.

     DENSITY IS A TIER, NOT A CLASS OVERRIDE. Three of them, because the app had independently settled on three
     and named none: settings rows breathe (`comfortable`), record lists are read in bulk (`compact`), and a
     navigator rail is scanned (`dense`). A caller reaching for `py-2` by hand is the failure this replaces —
     and the reason the record lists hand-rolled their rows even where this component was importable.

     `flush` DROPS THE PADDING, for the row whose container already owns it — the exact counterpart of
     <RowGroup>'s `flat`, and it is what lets a CARD'S MASTHEAD be this component. That masthead (an icon, an
     h2, a line of explanation, sometimes a badge or a switch on the right) is the same anatomy as a settings
     row and was hand-written on fourteen cards, which is how it ended up with five different icon treatments —
     `text-lg text-muted`, `mt-0.5 text-lg text-muted`, `mt-0.5 shrink-0 text-lg text-warning`, `text-lg
     text-success`, `text-base text-link` — and disagreed with itself about whether the icon centres on the
     block (`items-center`) or hangs off its first line (`items-start` + `mt-0.5`). The second spelling is the
     one that reads as broken: a lock nudged half a line down the left of a three-line paragraph is aligned to
     nothing, which is what "the icon looks off" turns out to mean every time it is reported.

     ONE RULE, AND IT IS `items-center`: the icon centres against the whole title-and-description block, at
     every density, padded or flush. A caller writing `mt-0.5` on a lead icon is re-opening the bug.

     Rounding is deliberately NOT a prop — it is the container's business, and Vue's fallthrough puts it one
     `class="rounded-md"` away for the rails that want it. -->
<script setup lang="ts">
import { type IconName } from "../icons/iconSets.js";
import Icon from "./Icon.vue";

const {
    as = `div`,
    interactive = false,
    chevron = false,
    tone = `default`,
    density = `comfortable`,
    selected = false,
    flush = false,
} = defineProps<{
    icon?: IconName;
    title?: string;
    description?: string;
    href?: string;
    /** `button` for a row that is PICKED (rails, selectable lists) — it is what puts the row on the tab order. */
    as?: `div` | `label` | `button`;
    interactive?: boolean;
    chevron?: boolean;
    tone?: `default` | `danger` | `warning` | `success` | `info`;
    /** comfortable: settings rows · compact: record lists · dense: navigator rails. */
    density?: `comfortable` | `compact` | `dense`;
    /** Paints the app-wide selected tint. Implies `interactive` — a row you can pick is a row you can hover. */
    selected?: boolean;
    /* Renders the title as a real heading, one step up in size. A card's masthead is an `h2` in the document,
     * not a styled div — and it has to outrank the rows UNDER it on the same surface, which is the one thing
     * unifying the two costs if the size is left to the tier: masthead and option row both land on
     * `font-semibold` at the SAME size and the card reads as two titles.
     *
     * `text-lg`, not `text-base` — this app scales its type off a 17.6px root, so `text-base` IS the body size
     * and setting it changes nothing (it was written that way first, and measured as a no-op). Only the
     * `comfortable` tier leaves the size unset, and a masthead is always comfortable, so nothing collides. It
     * lands between <PageHeader>'s `text-2xl` h1 and the rows beneath it, which is the rank an h2 should read
     * at anyway. */
    heading?: 2 | 3;
    /** Turns the lead icon, for the row that IS a wait ("activating your membership"). Kept as a prop rather
     *  than left to `#lead` so a spinning row still gets the tier's size and the tone's colour for free. */
    spin?: boolean;
    /** Drops the tier's padding, for a row whose container already provides it — see the note above. */
    flush?: boolean;
}>();

/* One table, so a tier is read in one place rather than reassembled from five ternaries down the template.
 * THE ICON SCALES WITH THE TIER. It used to be a flat `text-lg`, which is right for a settings row and a third
 * too big beside a rail row's `text-xs` title — the icon then reads as the row's subject and the name as its
 * annotation, which is backwards. */
const TIERS = {
    comfortable: { pad: `px-4 py-3`, gap: `gap-2.5`, icon: `text-lg`, title: `font-semibold leading-tight`, description: `text-xs` },
    compact: { pad: `px-4 py-2`, gap: `gap-2.5`, icon: `text-sm`, title: `text-sm font-medium leading-tight`, description: `text-2xs` },
    dense: { pad: `px-2 py-1.5`, gap: `gap-2`, icon: `text-xs`, title: `text-xs font-medium leading-tight`, description: `text-2xs` },
} as const;

/* The lead icon's colour, as a tone rather than as a class the caller brings. The three semantic ones are not
 * decoration — they are the card's state said in colour before its sentence is read (a warning triangle on
 * "sandbox is behind the app", an open lock the moment a bundle stops being safe to hand over) — and each was
 * previously spelled at its own call site, which is why one of them was `text-base` while its neighbours were
 * `text-lg`. `info` is the link colour, kept off the name `link` because nothing here navigates. */
const TONES = {
    default: `text-subtle`,
    danger: `text-danger`,
    warning: `text-warning`,
    success: `text-success`,
    info: `text-link`,
} as const;

/* A ROW YOU PICK FROM IS MUTED UNTIL YOU REACH FOR IT. All four selectable lists in the app had this rule and
 * all four spelled it themselves — the source rail, the memory index, the documentation contents and the log
 * file list — so a list of forty names reads as one quiet block with exactly one name lit, rather than forty
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
            // The app's one hover tint and one selected tint (styles/shared/utilities.css). This used to carry
            // its own `hover:bg-content/5` — the same 5% by luck rather than by reference.
            interactive || selected || href !== undefined || as !== `div` ? `ui-row-select` : ``,
            selected ? `ui-row-select-on` : ``,
        ]"
    >
        <div class="flex items-center justify-between gap-4">
            <div class="flex min-w-0 items-center" :class="TIERS[density].gap">
                <slot name="lead" />
                <Icon v-if="icon !== undefined" :name="icon" :spin="spin" class="shrink-0" :class="[TIERS[density].icon, TONES[tone]]" />
                <div class="min-w-0">
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
            </div>
            <div v-if="$slots[`meta`] || $slots[`control`] || chevron || href !== undefined" class="flex shrink-0 items-center gap-2">
                <!-- Facts, not controls: tabular so a column of sizes or times lines up down the list, and muted
                     so the row's name stays the thing the eye lands on. -->
                <div v-if="$slots[`meta`]" class="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-subtle">
                    <slot name="meta" />
                </div>
                <slot name="control" />
                <Icon v-if="chevron || href !== undefined" name="chevron-right" class="text-2xs text-subtle" />
            </div>
        </div>
        <div v-if="$slots[`below`]" class="mt-3">
            <slot name="below" />
        </div>
    </component>
</template>
