<!-- A LINE ON A <RowGroup>'S SURFACE THAT IS NOT A RECORD: the sentence explaining why a group is empty, the
     "nothing here yet" a list falls back to, and the "add one" at the end of it. Three shapes, one geometry, and
     the geometry is the group's own.

     IT EXISTS BECAUSE 58 OF THESE WERE HAND-WRITTEN, and between them they spelled one padding six ways:
     `px-3 py-2` on the extensions list, `px-4 py-3` in nine files, `px-4 py-4` on the personas list, `px-4
     py-2.5` (which is the compact tier, by luck rather than by reference), `px-4.5 py-3.5` (the comfortable one,
     same luck) and `py-2.5 pl-2.5 pr-3` on the two "write a skill" lines. Four of those match no tier at all, so
     the line sat a few pixels off the rows it shares a surface with — which is what "the sizes are inconsistent"
     looks like from the outside, and what nobody can fix in one place while every caller owns its own numbers.

     THE "ADD ONE" GLYPH RIDES THE CHEVRON'S COLUMN, at the chevron's size, and that is not decoration. Two
     files (the agent's skills list, the persona kit) opted OUT of <Row> for this line and wrote down why: "every
     tier of the shared row pads to px-4, which is what pushed the plus a step right of the chevron column the
     rest of this group is hung on." They were right about the problem and each guessed at the fix — one is at
     `pl-2.5`, and the rows above it are at `px-4` — so neither landed in that column either. Read from
     ROW_TOGGLE_GAPS/ROW_TOGGLE_SIZES, the same table <DisclosureRow> draws its own chevron from, it cannot miss:
     in a list of expandable rows the plus sits exactly where the arrows are, and in a list of plain ones it
     starts the lead column. It is punctuation, like the arrow, so it takes the arrow's size rather than the
     tier's icon size — a `text-lg` plus over a settings list reads as an item in it.

     A NAVIGATIONAL row is still <Row>, wrapped in the app's <RouterLink class="block"> — a line that GOES
     somewhere has a title, a description and a chevron, which is a row, not a note. -->
<script setup lang="ts">
import type { IconName } from "../icons/iconSets.js";
import Icon from "./Icon.vue";
import { ROW_BLOCK_PAD, ROW_TIERS, ROW_TOGGLE_GAPS, ROW_TOGGLE_SIZES, ROW_TONES, type RowTone, useRowDensity } from "./row.js";

const { variant = `note`, tone = `default` } = defineProps<{
    /* `note`: a sentence on the surface, in the group's own padding — "these appear after your first deploy".
     * `empty`: the centred "nothing here yet", with the vertical room an empty surface is owed.
     * `action`: a pressable line that ADDS one — "Add a secret", "Write a skill".
     * `block`: arbitrary content — a form, a figure, an invite box — padded like an open row's drawer, which is
     *   the same shape on the same surface and was the other half of the hand-written padding. It brings NO
     *   type or colour of its own: what is inside a block is the caller's, and only where it sits is ours. */
    variant?: `note` | `empty` | `action` | `block`;
    /** The leading glyph. `action` defaults to `plus`; a note draws none unless asked. */
    icon?: IconName;
    /** Tints the glyph, for the note that is a warning rather than a remark. */
    tone?: RowTone;
    /** `action` only: the line's own text, when it is a plain string. The slot wins if both are given. */
    label?: string;
    /** `action` only. */
    disabled?: boolean;
}>();

const emit = defineEmits<{ click: [event: MouseEvent] }>();

/* ALWAYS THE GROUP'S TIER, WITH NO PROP TO OVERRIDE IT. A row can legitimately disagree with its list — a
 * masthead outranks the rows under it — but a note is the surface talking about the list it is on, and there is
 * no reading under which it is a size of its own. Not offering the escape hatch is what keeps this from becoming
 * the 59th hand-written padding. */
const tier = useRowDensity(() => undefined);

/* An empty surface is owed more vertical room than a row is: the whole card is this one sentence, and set at
 * the row's own padding it reads as a row that lost its title. The compact figure is the `px-4 py-6` five
 * separate files had already converged on, kept exactly so nothing moves. */
const EMPTY_PAD = { comfortable: `px-4.5 py-7`, compact: `px-4 py-6`, dense: `px-2.5 py-5` } as const;

/* Prose, at the size of the tier's TITLE rather than of its description: this is a sentence somebody is meant
 * to read, not an annotation under a name. Muted, because it is not a record — the one thing every hand-written
 * version did agree on, apart from the keybindings list's `text-subtle`. */
const TEXT = { comfortable: `text-sm`, compact: `text-xs`, dense: `text-2xs` } as const;
</script>

<template>
    <div v-if="variant === `empty`" class="text-center text-muted" :class="[EMPTY_PAD[tier], TEXT[tier]]">
        <slot>{{ label }}</slot>
    </div>

    <!-- `mark` for the same reason <Row> hands it out: a block at the tail of a list regularly PREVIEWS the row
         it is about to add (the personas list draws the face the new row will wear), and that preview is only
         honest at the size those rows actually draw. -->
    <div v-else-if="variant === `block`" :class="ROW_BLOCK_PAD[tier]"><slot :mark="ROW_TIERS[tier].mark" /></div>

    <!-- The pressable one. `ui-row-select` is the app's one hover-and-focus treatment for a row you can press,
         the same utility <Row> takes for `interactive`, so this line lights up exactly like the records above
         it rather than in a wash of its own. -->
    <button
        v-else-if="variant === `action`"
        type="button"
        class="ui-row-select ui-off group flex w-full cursor-pointer items-center text-left"
        :class="[ROW_TIERS[tier].pad, ROW_TOGGLE_GAPS[tier], TEXT[tier]]"
        :disabled="disabled"
        @click="(event: MouseEvent) => emit(`click`, event)"
    >
        <Icon :name="icon ?? `plus`" aria-hidden="true" class="shrink-0" :class="[ROW_TOGGLE_SIZES[tier], ROW_TONES[tone]]" />
        <span class="min-w-0 text-muted transition-colors group-hover:text-content"
            ><slot>{{ label }}</slot></span
        >
    </button>

    <!-- `items-center`, and never `mt-0.5` on the glyph: <Row> states that rule for lead icons and states why —
         an icon nudged half a line down the left of a three-line paragraph is aligned to nothing, which is what
         "the icon looks off" turned out to mean every time it was reported. -->
    <div v-else class="flex items-center text-muted" :class="[ROW_TIERS[tier].pad, ROW_TIERS[tier].gap, TEXT[tier]]">
        <Icon v-if="icon !== undefined" :name="icon" aria-hidden="true" class="shrink-0" :class="[ROW_TOGGLE_SIZES[tier], ROW_TONES[tone]]" />
        <span class="min-w-0"
            ><slot>{{ label }}</slot></span
        >
    </div>
</template>
