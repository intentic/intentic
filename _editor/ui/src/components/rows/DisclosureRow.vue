<!-- A record row, built on <Row>, that opens into its own evidence below. -->
<script setup lang="ts">
import { computed, useId } from "vue";
import { FACE_SIZES } from "../brand/personaFace.js";
import Icon from "../primitives/Icon.vue";
import Row from "./Row.vue";
import type { IconName } from "../../icons/iconSets.js";
import { ROW_DRAWER_PAD, ROW_TIERS, ROW_TOGGLE_SIZES, type RowDensity, type RowTone, useRowDensity } from "./row.js";

const {
    open = false,
    density,
    lead = `icon`,
    hit = `header`,
    body = `rail`,
    tone = `default`,
    disabled = false,
    wideControl = false,
} = defineProps<{
    /** Open state; `v-model:open` for the row to own it, or bind + listen for a parent (e.g. an accordion) to. */
    open?: boolean;
    // Leave unset: the enclosing <RowGroup> publishes the tier, and a group defaults to compact. See <RowGroup>.
    density?: RowDensity;
    /** Forwarded to <Row>: `face` sizes `#lead` for a <PersonaFace> and pays for it out of the row's padding. */
    lead?: `icon` | `face`;
    // What the press target is (pressing the row always opens it; this only decides the button's edges).
    // `header`: lead + title + description are one button; the chevron sits in the trailing cluster like
    // <Row chevron>. `pair`: only the trailing chevron is; the headline's own controls (a link, a button)
    // keep their own clicks (see <Row>'s `headlineGuard`).
    hit?: `header` | `pair`;
    /** `rail`: evidence about this row, hangs off its title. `drawer`: a place of its own, full width, own boundary. */
    body?: `rail` | `drawer`;
    // Forwarded to <Row> verbatim (the four props a disclosure row actually uses); `class` lands on the wrapper.
    icon?: IconName;
    title?: string;
    description?: string;
    wideControl?: boolean;
    /** Tints <Row>'s `icon`. */
    tone?: RowTone;
    /** A row with nothing behind it: the chevron goes, the row stays. */
    disabled?: boolean;
}>();

const emit = defineEmits<{ "update:open": [open: boolean] }>();

const bodyId = useId();

const toggle = (): void => {
    if (!disabled) {
        emit(`update:open`, !open);
    }
};

// A drag is not a press, so selecting text inside the row must not also toggle it. Measured from pointerdown
// position rather than `getSelection()`; `event.detail > 0` excludes synthetic keyboard clicks (which land at 0,0).
const PRESS_SLOP_PX = 6;
let pressedAt: { x: number; y: number } | undefined;

const onPointerDown = (event: PointerEvent): void => {
    pressedAt = { x: event.clientX, y: event.clientY };
};

const dragged = (event: MouseEvent): boolean =>
    event.detail > 0 && pressedAt !== undefined && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > PRESS_SLOP_PX;

// The whole row is the target except where it's a control; a text-only hit area would leave most of the
// row's own padding dead.
const onRowClick = (event: MouseEvent): void => {
    if (!dragged(event)) {
        toggle();
    }
};

// Written out rather than as a `.stop` modifier: the trailing chevron must not also bubble into the
// row-wide handler and toggle straight back.
const onPairClick = (event: MouseEvent): void => {
    if (hit === `header`) {
        return;
    }
    event.stopPropagation();
    if (!dragged(event)) {
        toggle();
    }
};

// Resolved once and passed down to <Row> explicitly, so the hidden mirror below can't disagree about
// which tier it's mirroring.
const tier = useRowDensity(() => density);

// Read from <Row>'s own tier table, so the hidden mirror below stays in step with what it mirrors.
const gap = computed(() => ROW_TIERS[tier.value].gap);
const mark = computed(() => (lead === `face` ? FACE_SIZES.row : ROW_TIERS[tier.value].mark));
const chevronSize = computed(() => ROW_TOGGLE_SIZES[tier.value]);

// The one open-row tint, so every list in the app shades an open row the same colour.
const tint = computed(() => {
    if (disabled) {
        return ``;
    }
    if (open) {
        return `bg-content/6`;
    }
    return ``;
});

// Hover wash lives on the wrapper, not <Row>, so it still covers the row once a drawer removes <Row>'s
// own bottom padding.
const wrapperSelect = computed(() => (disabled ? `` : `ui-row-select`));

// Drawer padding: less top air than ROW_BLOCK_PAD, since the header row's own padding already separates them.
</script>

<template>
    <!-- With a selection column, a grid: the column and <Row> share its first line and the drawer spans both under them. -->
    <div
        class="group"
        :class="[tint, wrapperSelect, $slots[`before`] ? `grid grid-cols-[auto_minmax(0,1fr)] items-center` : ``]"
        @pointerdown="onPointerDown"
    >
        <!-- The selection column, outside the toggle: a checkbox can't nest in the button that opens the row. -->
        <div v-if="$slots[`before`]" class="flex shrink-0 items-center"><slot name="before" /></div>
        <Row
            :class="open && body === `drawer` ? `!pb-0` : ``"
            :density="tier"
            :lead="lead"
            :tone="tone"
            :icon="icon"
            :title="title"
            :description="description"
            :wide-control="wideControl"
            :header-button="hit === `header` && !disabled"
            :header-expanded="disabled ? undefined : open"
            :header-controls="disabled ? undefined : bodyId"
            :headline-guard="hit === `pair`"
            @header-click="onRowClick"
            @click="onRowClick"
        >
            <template #lead>
                <!-- The tier's mark size, forwarded so a disclosure row's lead is written exactly like a plain row's. -->
                <slot name="lead" :mark="mark" :icon-class="ROW_TIERS[tier].icon" />
            </template>

            <template v-if="$slots[`title`]" #title><slot name="title" /></template>
            <template v-if="$slots[`description`]" #description><slot name="description" /></template>
            <!-- Trailing cluster matches <Row chevron>: facts, then the disclosure mark at the right edge. -->
            <template v-if="$slots[`meta`] || !disabled" #meta>
                <slot name="meta" />
                <!-- In `pair` this button IS the keyboard's way into the toggle, since the row-wide click handler only reaches pointers. -->
                <component
                    :is="hit !== `header` && !disabled ? `button` : `span`"
                    :type="hit !== `header` && !disabled ? `button` : undefined"
                    :aria-expanded="hit !== `header` && !disabled ? open : undefined"
                    :aria-controls="hit !== `header` && !disabled ? bodyId : undefined"
                    :class="
                        hit !== `header` && !disabled
                            ? `cursor-pointer rounded-sm text-subtle hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500`
                            : ``
                    "
                    @click="onPairClick"
                >
                    <!-- Rotation, not an icon swap: `chevron-up`/`chevron-down` are two names a caller could get backwards. -->
                    <Icon
                        v-if="!disabled"
                        name="chevron-right"
                        class="shrink-0 text-subtle transition-transform group-hover:text-muted"
                        :class="[chevronSize, open ? `rotate-90` : ``]"
                        aria-hidden="true"
                    />
                </component>
            </template>
            <template v-if="$slots[`control`]" #control><slot name="control" /></template>

            <!-- The rail: inside <Row>'s padding so it aligns with the row above, offset by a hidden copy of the lead so it starts
                 flush under the title. No rule beside it: the open row's wash and that indent already say whose evidence it is. -->
            <template v-if="open && body === `rail`" #below>
                <div class="flex" :class="gap">
                    <!-- The lead, mirrored and hidden, so the block starts where the title does. -->
                    <span class="invisible flex shrink-0 items-center" :class="gap" inert aria-hidden="true">
                        <slot name="lead" :mark="mark" :icon-class="ROW_TIERS[tier].icon" />
                        <Icon v-if="icon !== undefined" :name="icon" :class="ROW_TIERS[tier].icon" />
                    </span>
                    <!-- `.stop`: this sits inside <Row>, whose row-wide handler would otherwise read a press on the evidence as "close what you just opened.". -->
                    <div :id="bodyId" class="min-w-0 flex-1 cursor-auto" @click.stop>
                        <slot name="below" />
                    </div>
                </div>
            </template>
        </Row>

        <!-- The drawer: a sibling of <Row>, not its `#below`, since it's full-bleed and pulling it out of <Row>'s padding would need tier-matched negative margins. -->
        <div
            v-if="open && body === `drawer`"
            :id="bodyId"
            class="cursor-auto border-t border-line-subtle"
            :class="[ROW_DRAWER_PAD[tier], $slots[`before`] ? `col-span-full` : ``]"
        >
            <slot name="below" />
        </div>
    </div>
</template>
