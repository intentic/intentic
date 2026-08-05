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
} = defineProps<{
    icon?: IconName;
    title?: string;
    description?: string;
    href?: string;
    /** `button` for a row that is PICKED (rails, selectable lists) — it is what puts the row on the tab order. */
    as?: `div` | `label` | `button`;
    interactive?: boolean;
    chevron?: boolean;
    tone?: `default` | `danger`;
    /** comfortable: settings rows · compact: record lists · dense: navigator rails. */
    density?: `comfortable` | `compact` | `dense`;
    /** Paints the app-wide selected tint. Implies `interactive` — a row you can pick is a row you can hover. */
    selected?: boolean;
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
            TIERS[density].pad,
            // The app's one hover tint and one selected tint (styles/shared/utilities.css). This used to carry
            // its own `hover:bg-content/5` — the same 5% by luck rather than by reference.
            interactive || selected || href !== undefined || as !== `div` ? `ui-row-select` : ``,
            selected ? `ui-row-select-on` : ``,
        ]"
    >
        <div class="flex items-center justify-between gap-4">
            <div class="flex min-w-0 items-center" :class="TIERS[density].gap">
                <slot name="lead" />
                <Icon
                    v-if="icon !== undefined"
                    :name="icon"
                    class="shrink-0"
                    :class="[TIERS[density].icon, tone === `danger` ? `text-danger` : `text-subtle`]"
                />
                <div class="min-w-0">
                    <div
                        v-if="title !== undefined || $slots[`title`]"
                        class="min-w-0"
                        :class="[TIERS[density].title, picked && !selected ? `text-muted group-hover:text-content` : `text-content`]"
                    >
                        <slot name="title">{{ title }}</slot>
                    </div>
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
