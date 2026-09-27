<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { type ProofMark, sealOf } from "./proofSeal";

// THE CARD'S SEAL: one glyph for what its last turn showed of its own work, drawn on the icon pack's own octagon. Closed,
// it is exactly the pack's `check-circle`, the mark a landed card always wore, so a finished card keeps its glyph and
// only the ring around the tick changes:
//   closed    every check the turn ran after its last edit passed
//   open      the ring's corners break: the work is done and nothing proved it (no check after the last edit, or an
//             interface changed unseen)
//   broke     the pack's red `!`: its own last check failed
// Its words are the hover's, one reading per line, a failure's included: the card spends no line on any of them. A mark,
// never a press, so a click on it is the card's, which opens the card; on the rail the row is a button of its own.

const t = useT();

const props = defineProps<{
    proof: ProofMark;
    // A receipt card (AgentCard): a closed seal is history there, so it takes the row's ink instead of green.
    quiet?: boolean;
    // The status this glyph stands in for in the card's corner (Landed, Idle), said first in the hover so the corner
    // still says what it said before the seal took it.
    status?: string;
}>();

// The pack's octagon (statusGlyphs `check-circle`), from a corner, so the dashed ring's gaps are centred on the corners.
const OCTAGON = `M8 3h8l5 5v8l-5 5H8l-5-5V8Z`;
const TICK = `M7 12l3 3 7-7`;
// A gap of 2.4 units at each corner: the octagon's straight sides are 8 long and its diagonals 5√2 (7.07), so each side
// keeps a dash of its length less one gap, and the offset starts the pattern halfway through the gap that ends at the
// corner the path begins from.
const OPEN_DASHES = `5.6 2.4 4.67 2.4`;
const OPEN_OFFSET = `13.87`;

const kind = computed(() => sealOf(props.proof));

const tone = computed(() => {
    if (kind.value === `broke`) {
        return `text-danger`;
    }
    return kind.value === `closed` && props.quiet !== true ? `text-success` : `text-muted`;
});

// A tooltip is 17rem wide and five lines tall, and a targeted test command can fill both on its own.
const CHECK_CHARS = 44;
const clipped = (check: string): string => (check.length > CHECK_CHARS ? `${check.slice(0, CHECK_CHARS - 1)}…` : check);

const proofLines = (proof: ProofMark): string[] => {
    const lines: string[] = [];
    const check = proof.check === undefined ? undefined : clipped(proof.check);
    if (proof.verification === `verified`) {
        lines.push(check === undefined ? t(`agents.cardSeal.verifiedBare`) : t(`agents.cardSeal.verified`, { check }));
    } else if (proof.verification === `failing`) {
        lines.push(check === undefined ? t(`agents.cardSeal.failedBare`) : t(`agents.cardSeal.failed`, { check }));
    } else if (proof.verification === `unproven`) {
        lines.push(t(`agents.cardSeal.unproven`));
    }
    if (proof.unviewed !== undefined) {
        lines.push(t(`agents.cardSeal.unviewed`, { count: proof.unviewed }, proof.unviewed));
    }
    return lines;
};

const hover = computed(() => [...(props.status === undefined ? [] : [props.status]), ...proofLines(props.proof)].join(`\n`));
</script>

<template>
    <span class="inline-flex shrink-0 items-center" :class="tone" data-seal :data-seal-kind="kind">
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="1em"
            height="1em"
            role="img"
            focusable="false"
            :aria-label="hover"
            v-tooltip.top.lines="hover"
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
    </span>
</template>
