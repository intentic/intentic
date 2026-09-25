<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { useReducedMotion } from "@intentic/ui/reduced-motion";
import { computed } from "vue";
import { type CardChecks, type LandCheck, type ProofMark, sealOf } from "./landCheck";
import { brokeLabel, projectName, sinceWhen } from "./mainlineView";
import { openLandConversation } from "./openLanded";

// THE CARD'S SEAL: one glyph for how far a card's work got, drawn on the icon pack's own octagon. Closed, it is exactly
// the pack's `check-circle`, the mark a landed card always wore, so a finished card keeps its glyph and only the ring
// around the tick changes:
//   closed    every reading that came back passed
//   open      the ring's corners break: the work is done and nothing proved it (no check after the last edit, an
//             interface changed unseen, or main still red from other work)
//   checking  a stroke travels the ring while main's check runs on its land
//   queued    the same ring, faint and still, while its land waits for that check: nothing is happening to it yet
//   broke     the pack's red `!`: its land broke main, or its own last check failed
// The worst reading wins (landCheck.sealOf). Its words are the hover's, one reading per line, a red's included: the card
// spends no line on any of them, and nothing on it ticks, since the dock already counts the one check that is running.
// A red someone is already fixing is also the press to that conversation, on the board; the rail's row is a button of
// its own, so there the glyph only says it.

const t = useT();

const props = defineProps<{
    checks: CardChecks;
    // A receipt card (AgentCard): a closed seal is history there, so it takes the row's ink instead of green.
    quiet?: boolean;
    // The status this glyph stands in for in the card's corner (Landed, Idle), said first in the hover so the corner
    // still says what it said before the seal took it.
    status?: string;
    // The rail's row, itself a button, so the seal cannot be one there.
    compact?: boolean;
    // The card's own turn is working, and its status glyph already moves: one moving mark per card, so a running check
    // wears the queued ring here (its hover still says it is running) rather than a second spinner, moving or frozen.
    still?: boolean;
}>();

// The pack's octagon (statusGlyphs `check-circle`), from a corner for the dashed ring, whose gaps are centred on the
// corners, and from the middle of the top edge for the travelling stroke, so the seam where the stroke wraps lies on a
// straight edge rather than notching a corner.
const OCTAGON = `M8 3h8l5 5v8l-5 5H8l-5-5V8Z`;
const OCTAGON_FROM_TOP = `M12 3h4l5 5v8l-5 5H8l-5-5V8l5-5Z`;
const TICK = `M7 12l3 3 7-7`;
// A gap of 2.4 units at each corner: the octagon's straight sides are 8 long and its diagonals 5√2 (7.07), so each side
// keeps a dash of its length less one gap, and the offset starts the pattern halfway through the gap that ends at the
// corner the path begins from.
const OPEN_DASHES = `5.6 2.4 4.67 2.4`;
const OPEN_OFFSET = `13.87`;

const kind = computed(() => sealOf(props.checks));

// Slower, never still: a still stroke beside live work reads as hung (useReducedMotion).
const reduced = useReducedMotion();

const tone = computed(() => {
    if (kind.value === `broke`) {
        return `text-danger`;
    }
    if (kind.value === `checking` || kind.value === `queued`) {
        return `text-link`;
    }
    return kind.value === `closed` && props.quiet !== true ? `text-success` : `text-muted`;
});

const landLine = (land: LandCheck): string => {
    const project = projectName(land.project);
    const time = sinceWhen(land.since);
    if (land.kind === `checking`) {
        return t(`agents.landCheck.seal.checking`, { project, time });
    }
    if (land.kind === `waiting`) {
        return t(`agents.landCheck.seal.waiting`, { project, time });
    }
    if (land.kind === `passed`) {
        return t(`agents.landCheck.seal.passed`, { project, time });
    }
    if (land.kind === `checked-red`) {
        return t(`agents.landCheck.seal.checkedRed`, { project });
    }
    return t(`agents.landCheck.seal.broke`, { project, broke: brokeLabel(land.failures ?? 0, land.routing) });
};

// A tooltip is 17rem wide and five lines tall, and a targeted test command can fill both on its own.
const CHECK_CHARS = 44;
const clipped = (check: string): string => (check.length > CHECK_CHARS ? `${check.slice(0, CHECK_CHARS - 1)}…` : check);

const proofLines = (proof: ProofMark): string[] => {
    const lines: string[] = [];
    const check = proof.check === undefined ? undefined : clipped(proof.check);
    if (proof.verification === `verified`) {
        lines.push(check === undefined ? t(`agents.landCheck.seal.verifiedBare`) : t(`agents.landCheck.seal.verified`, { check }));
    } else if (proof.verification === `failing`) {
        lines.push(check === undefined ? t(`agents.landCheck.seal.failedBare`) : t(`agents.landCheck.seal.failed`, { check }));
    } else if (proof.verification === `unproven`) {
        lines.push(t(`agents.landCheck.seal.unproven`));
    }
    if (proof.unviewed !== undefined) {
        lines.push(t(`agents.landCheck.unviewed`, { count: proof.unviewed }, proof.unviewed));
    }
    return lines;
};

// The OTHER conversation that has this card's red, when there is one and this seal may be pressed.
const fixUp = computed(() => (props.compact === true || props.checks.land?.kind !== `broke` ? undefined : props.checks.land.fixUp));

// Main's verdict first: it is about work already in the tree, the proof only about how the turn left it.
const hover = computed(() =>
    [
        ...(props.status === undefined ? [] : [props.status]),
        ...(props.checks.land === undefined ? [] : [landLine(props.checks.land)]),
        ...(props.checks.proof === undefined ? [] : proofLines(props.checks.proof)),
        ...(fixUp.value === undefined ? [] : [t(`agents.landCheck.openFixUp`)]),
    ].join(`\n`),
);

// Stopped only when it opens something: a plain seal's click is the card's, which opens the card.
const press = (event: MouseEvent): void => {
    if (fixUp.value !== undefined) {
        event.stopPropagation();
        openLandConversation(fixUp.value);
    }
};
</script>

<template>
    <component
        :is="fixUp === undefined ? `span` : `button`"
        :type="fixUp === undefined ? undefined : `button`"
        class="inline-flex shrink-0 items-center"
        :class="[tone, fixUp === undefined ? `` : `-m-0.5 rounded p-0.5 hover:bg-overlay`]"
        data-seal
        :data-seal-kind="kind"
        @click="press"
    >
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
                    <path
                        v-else-if="kind === `open`"
                        :d="OCTAGON"
                        stroke-linecap="butt"
                        :stroke-dasharray="OPEN_DASHES"
                        :stroke-dashoffset="OPEN_OFFSET"
                    />
                    <template v-else>
                        <!-- The track at the spinner's own quiet fraction of the ink (Icon.vue); SMIL, like the spinner, so DevTools' CSS animation model is left alone. -->
                        <path :d="OCTAGON" opacity="0.35" />
                        <path v-if="kind === `checking` && still !== true" :d="OCTAGON_FROM_TOP" pathLength="60" stroke-linecap="butt" stroke-dasharray="15 45">
                            <animate
                                attributeName="stroke-dashoffset"
                                from="0"
                                to="-60"
                                :dur="reduced ? `6s` : `2.4s`"
                                repeatCount="indefinite"
                            />
                        </path>
                    </template>
                    <path :d="TICK" />
                </template>
            </g>
        </svg>
    </component>
</template>

