<!--
    One row inside a <RowGroup> or <NavRail>: `#lead`, title + description, a `#meta` cluster of facts, and a `#control` cluster of actions; `#below`
    drops full-width content on the same row. `#meta` and `#control` stay separate because facts and actions render differently. Purely
    presentational, no router dependency.
-->
<script setup lang="ts">
import type { IconName } from "../../icons/iconSets.js";
import Icon from "../primitives/Icon.vue";
import { ROW_TIERS as TIERS, ROW_TONES as TONES, type RowDensity, type RowTone, useRowDensity } from "./row.js";

const {
    as = `div`,
    interactive = false,
    chevron = false,
    tone = `default`,
    density,
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
    /** `button` for a row that is PICKED (rails, selectable lists): it's what puts the row on the tab order. */
    as?: `div` | `label` | `button`;
    interactive?: boolean;
    chevron?: boolean;
    tone?: RowTone;
    // Leave unset inside a <RowGroup> (it publishes the tier); outside one this falls back to `comfortable`,
    // the masthead's tier.
    density?: RowDensity;
    /** Paints the app-wide selected tint; implies `interactive`, since a row you can pick is a row you can hover. */
    selected?: boolean;
    // Renders the title as a real heading, one step up in size (`text-lg`, since this app's `text-base` IS body size).
    heading?: 2 | 3;
    /** Spins the lead icon, for a row that IS a wait; kept as a prop so it still gets the tier's size and tone. */
    spin?: boolean;
    /** Drops the tier's padding, for a row whose container already provides it. */
    flush?: boolean;
    // Lets the trailing cluster take the title's leftover space (`basis-0 grow`) instead of claiming its own
    // width, so a wrapping control (many swatches) takes a second line rather than squeezing the title.
    wideControl?: boolean;
    // Makes the left region (lead, title, description) one `<button>`, with `#meta`/`#control` outside it as
    // separate controls; for <DisclosureRow>, so trailing verbs don't nest inside the toggle.
    headerButton?: boolean;
    /** `aria-expanded` for the header button; leave unset on a header button that isn't a disclosure. */
    headerExpanded?: boolean;
    /** `aria-controls` for the header button: the id of the block it opens. */
    headerControls?: string;
    // The headline's own controls (a link, a button) swallow their clicks; the rest of the headline stays
    // part of the row's press target. Judged by what the click landed on, so a title that stops being a
    // link can't leave this stale.
    headlineGuard?: boolean;
    // Hangs `#below` off a spine under the row's own lead mark, not the text column, so a sub-block reads as
    // belonging to this row. Width comes from a hidden second copy of the lead, never a typed number.
    spine?: boolean;
}>();

const emit = defineEmits<{ headerClick: [event: MouseEvent] }>();

// The tier in force: this row's own `density` if given, else the enclosing <RowGroup>'s.
const tier = useRowDensity(() => density);

// The header button eats its own click, or its press and the row's outer press (<DisclosureRow>) would
// both fire and the row would toggle straight back.
const onHeaderClick = (event: MouseEvent): void => {
    if (!headerButton) {
        return;
    }
    event.stopPropagation();
    emit(`headerClick`, event);
};

// What counts as a control for `headlineGuard`: the native interactives plus their ARIA-role equivalents.
const HEADLINE_CONTROLS = `a[href], button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [contenteditable="true"]`;

// See `headlineGuard`. Scoped with `contains`, not `closest` alone, so it can't match a control outside
// the headline (e.g. a `hit="header"` button that owns the whole row).
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

// A row you pick from stays muted until reached for; keyed on `as="button"`, the signal that this row
// is one of a set.
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
            flush ? `` : TIERS[tier].pad,
            // The app's one hover tint and one selected tint (styles/utilities.css). This used to carry
            // its own `hover:bg-content/5`: the same 5% by luck rather than by reference.
            interactive || selected || href !== undefined || as !== `div` ? `ui-row-select` : ``,
            selected ? `ui-row-select-on` : ``,
        ]"
    >
        <!--
            The selection column leads the HEADLINE, not the whole row or `#lead`, so it stays aligned even when
            `#below` adds lines beneath the row.
        -->
        <div :class="$slots[`before`] ? `flex items-center ${TIERS[tier].gap}` : `contents`">
            <div v-if="$slots[`before`]" class="flex shrink-0 items-center"><slot name="before" /></div>
            <div :class="$slots[`before`] ? `min-w-0 flex-1` : `contents`">
                <div class="flex items-center justify-between gap-4">
                    <!--
                        The left region takes the free space (`flex-1`) rather than shrink-wrapping the title, so the
                        gap
                        after a short name is still part of the hit area.
                    -->
                    <component
                        :is="headerButton ? `button` : `div`"
                        :type="headerButton ? `button` : undefined"
                        :aria-expanded="headerButton ? headerExpanded : undefined"
                        :aria-controls="headerButton ? headerControls : undefined"
                        class="flex min-w-0 items-center"
                        :class="[
                            TIERS[tier].gap,
                            headerButton
                                ? `flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary-500`
                                : ``,
                        ]"
                        @click="onHeaderClick"
                    >
                        <!--
                            The lead mark's size, handed to the slot so callers don't look up or restate the tier's
                            number.
                        -->
                        <slot name="lead" :mark="TIERS[tier].mark" />
                        <Icon
                            v-if="icon !== undefined"
                            :name="icon"
                            :spin="spin"
                            class="shrink-0"
                            :class="[TIERS[tier].icon, selected && tone === `default` ? `text-link` : TONES[tone]]"
                        />
                        <div class="min-w-0" @click="onHeadlineClick">
                            <component
                                :is="heading === undefined ? `div` : `h${heading}`"
                                v-if="title !== undefined || $slots[`title`]"
                                class="min-w-0"
                                :class="[
                                    TIERS[tier].title,
                                    heading === undefined ? `` : `text-lg`,
                                    picked && !selected ? `text-muted group-hover:text-content` : `text-content`,
                                ]"
                            >
                                <slot name="title">{{ title }}</slot>
                            </component>
                            <p v-if="description !== undefined || $slots[`description`]" class="min-w-0 text-muted" :class="TIERS[tier].description">
                                <slot name="description">{{ description }}</slot>
                            </p>
                        </div>
                    </component>
                    <div
                        v-if="$slots[`meta`] || $slots[`control`] || chevron || href !== undefined"
                        class="flex items-center gap-2"
                        :class="wideControl ? `grow basis-0 flex-wrap justify-end` : `shrink-0`"
                    >
                        <!--
                            Facts, not controls: tabular so a column of sizes/times lines up, muted so the row's name
                            still leads.
                        -->
                        <div v-if="$slots[`meta`]" class="flex shrink-0 items-center gap-2 text-2xs tabular-nums text-subtle">
                            <slot name="meta" />
                        </div>
                        <!--
                            `display: contents` keeps the cluster's layout invisible while still catching clicks
                            (`.stop`), so a
                            control here never also toggles the row. `#meta` is deliberately not wrapped: a press on a
                            fact may
                            as well open the row.
                        -->
                        <div v-if="$slots[`control`]" class="contents" @click.stop><slot name="control" /></div>
                        <Icon v-if="chevron || href !== undefined" name="chevron-right" class="text-2xs text-subtle" />
                    </div>
                </div>
            </div>
        </div>
        <div v-if="$slots[`below`]" class="mt-3" :class="$slots[`before`] ? `flex ${TIERS[tier].gap}` : ``">
            <!--
                The `#before` column, mirrored and hidden, so `#below` aligns under the headline instead of a typed
                number going stale. `inert` as well as `aria-hidden`: a mirrored checkbox would be a second focus stop.
            -->
            <span v-if="$slots[`before`]" class="invisible flex shrink-0 items-center" inert aria-hidden="true"><slot name="before" /></span>
            <div :class="$slots[`before`] ? `min-w-0 flex-1` : `contents`">
                <!--
                    The spine's own lead mirror, absolutely positioned to centre on that column without adding to its
                    height. `inert` because `#lead` may hold a real control, and a mirror of it would be a second,
                    unreachable copy.
                -->
                <div v-if="spine" class="flex" :class="TIERS[tier].gap">
                    <div class="relative flex shrink-0 justify-center">
                        <span class="invisible flex items-center" :class="TIERS[tier].gap" inert aria-hidden="true">
                            <slot name="lead" :mark="TIERS[tier].mark" />
                            <Icon v-if="icon !== undefined" :name="icon" :class="TIERS[tier].icon" />
                        </span>
                        <span class="absolute inset-y-0 w-px bg-line-strong" aria-hidden="true" />
                    </div>
                    <div class="min-w-0 flex-1"><slot name="below" /></div>
                </div>
                <slot v-else name="below" />
            </div>
        </div>
    </component>
</template>
