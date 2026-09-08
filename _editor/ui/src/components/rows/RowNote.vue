<!--
    A non-record line on a <RowGroup>'s surface: an empty-state sentence, a fallback message, or an "add one" affordance. The add glyph rides the
    chevron's column and size (ROW_TOGGLE_GAPS/ROW_TOGGLE_SIZES), so it lines up with disclosure rows above it. A navigational line is <Row>, not
    this.
-->
<script setup lang="ts">
import type { IconName } from "../../icons/iconSets.js";
import Icon from "../primitives/Icon.vue";
import { ROW_BLOCK_PAD, ROW_TIERS, ROW_TOGGLE_GAPS, ROW_TOGGLE_SIZES, ROW_TONES, type RowTone, useRowDensity } from "./row.js";

const { variant = `note`, tone = `default` } = defineProps<{
    // `note`: a sentence in the group's padding. `empty`: centred "nothing here yet", with room for an empty surface.
    // `action`: a pressable line that adds one. `block`: arbitrary content (a form, a figure), padded like an
    // open row's drawer; brings no type or colour of its own.
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

// Always the group's tier, with no override: a note is the surface talking about the list it's on, never
// a size of its own.
const tier = useRowDensity(() => undefined);

// An empty surface is owed more vertical room than a row: the whole card is this one sentence.
const EMPTY_PAD = { comfortable: `px-4.5 py-7`, compact: `px-4 py-6`, dense: `px-2.5 py-5` } as const;

// Prose at the tier's title size, not its description size: a sentence to read, not an annotation under a name.
const TEXT = { comfortable: `text-sm`, compact: `text-xs`, dense: `text-2xs` } as const;
</script>

<template>
    <div v-if="variant === `empty`" class="text-center text-muted" :class="[EMPTY_PAD[tier], TEXT[tier]]">
        <slot>{{ label }}</slot>
    </div>

    <!--
        `mark` for the same reason <Row> hands it out: a block at the tail of a list often previews the row it's
        about to add, and that's only honest at the size those rows actually draw.
    -->
    <div v-else-if="variant === `block`" :class="ROW_BLOCK_PAD[tier]"><slot :mark="ROW_TIERS[tier].mark" /></div>

    <!-- The pressable one; `ui-row-select` is the app's one hover-and-focus treatment for a row you can press. -->
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

    <!-- `items-center`, never `mt-0.5` on the glyph: a nudged icon beside a multi-line paragraph aligns to nothing. -->
    <div v-else class="flex items-center text-muted" :class="[ROW_TIERS[tier].pad, ROW_TIERS[tier].gap, TEXT[tier]]">
        <Icon v-if="icon !== undefined" :name="icon" aria-hidden="true" class="shrink-0" :class="[ROW_TOGGLE_SIZES[tier], ROW_TONES[tone]]" />
        <span class="min-w-0"
            ><slot>{{ label }}</slot></span
        >
    </div>
</template>
