<script setup lang="ts">
import { computed, useId } from "vue";
import type { StampKind } from "../../models/fleet/board/stamps";

// ONE STAMP AS A BADGE: a solid seal with a scalloped rim, the shape of a "verified" rosette, with its kind's symbol cut
// out of the middle. Every kind wears the same seal, so a row of them reads as one family of awards rather than as
// toolbar glyphs. The symbol says which check it was. The seal's ink, set by the caller (stamps.stampTone), says how
// the check came out. Drawn for 14–20px; the symbols are kept to a few strokes so they survive at that size.

const props = defineProps<{ kind: StampKind }>();

// Twelve lobes on a 24-unit square: each runs from a valley 9.8 from the centre to a peak at 11.5.
const SEAL = `M9.46 2.53Q12 -1.53 14.54 2.53Q18.77 0.28 18.93 5.07Q23.72 5.23 21.47 9.46Q25.53 12 21.47 14.54Q23.72 18.77 18.93 18.93Q18.77 23.72 14.54 21.47Q12 25.53 9.46 21.47Q5.23 23.72 5.07 18.93Q0.28 18.77 2.53 14.54Q-1.53 12 2.53 9.46Q0.28 5.23 5.07 5.07Q5.23 0.28 9.46 2.53Z`;

// The symbol each kind's seal has cut out of it: strokes, and an optional solid. A kind added to the contract fails the
// build here until it has a symbol of its own.
//   self    a command prompt: the agent ran a command on its own work
//   review  an eye: someone read the code
//   test    a flask: someone tried it out
const SYMBOLS = {
    self: { strokes: `M7.5 8.5l3.5 3.5-3.5 3.5 M12.5 15.5h4` },
    review: { strokes: `M6 12q6-6.5 12 0q-6 6.5-12 0Z`, solid: `M12 10a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z` },
    test: { strokes: `M10 6.5h4 M10.5 6.5v3.5l-3.5 7h10l-3.5-7V6.5` },
} as const satisfies Record<StampKind, { strokes: string; solid?: string }>;

// The cut-out is a mask, so the symbol shows whatever the badge sits on, a card, a hover or a selected row alike.
const mask = useId();
const symbol = computed(() => SYMBOLS[props.kind]);
</script>

<template>
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width="1em"
        height="1em"
        focusable="false"
        aria-hidden="true"
        class="inline-block flex-none"
        data-stamp-badge
        :data-stamp-kind="kind"
    >
        <mask :id="mask">
            <rect width="24" height="24" fill="white" />
            <path :d="symbol.strokes" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            <path v-if="`solid` in symbol" :d="symbol.solid" fill="black" />
        </mask>
        <path :d="SEAL" fill="currentColor" :mask="`url(#${mask})`" />
    </svg>
</template>
