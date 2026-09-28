<script setup lang="ts">
import type { SealKind } from "./proofSeal";

// The seal's glyph alone, drawn on the icon pack's own octagon, so the card's corner and the head of its overlay draw
// the one shape. Closed, it is exactly the pack's `check-circle`, the mark a landed card always wore:
//   closed    every check the turn ran after its last edit passed
//   open      the ring's corners break: the work is done and nothing proved it
//   broke     the pack's red `!`: its own last check failed

defineProps<{ kind: SealKind }>();

// The pack's octagon (statusGlyphs `check-circle`), from a corner, so the dashed ring's gaps are centred on the corners.
const OCTAGON = `M8 3h8l5 5v8l-5 5H8l-5-5V8Z`;
const TICK = `M7 12l3 3 7-7`;
// A gap of 2.4 units at each corner: the octagon's straight sides are 8 long and its diagonals 5√2 (7.07), so each side
// keeps a dash of its length less one gap, and the offset starts the pattern halfway through the gap that ends at the
// corner the path begins from.
const OPEN_DASHES = `5.6 2.4 4.67 2.4`;
const OPEN_OFFSET = `13.87`;
</script>

<template>
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        focusable="false"
        class="inline-block flex-none align-[-0.125em]"
    >
        <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" stroke-miterlimit="2">
            <template v-if="kind === `broke`">
                <path :d="`${OCTAGON} M12 7v6`" />
                <path d="M11 16h2v2h-2Z" fill="currentColor" stroke="none" />
            </template>
            <template v-else>
                <path v-if="kind === `closed`" :d="OCTAGON" />
                <path v-else :d="OCTAGON" stroke-linecap="butt" :stroke-dasharray="OPEN_DASHES" :stroke-dashoffset="OPEN_OFFSET" />
                <path :d="TICK" />
            </template>
        </g>
    </svg>
</template>
