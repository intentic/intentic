<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { ui } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { formatElapsed } from "../fleet/agentStatus";
import type { CardChecks, LandCheck, ProofMark } from "./landCheck";
import { projectName, routingMeta, sinceWhen } from "./mainlineView";
import { openLandConversation } from "./openLanded";

// A card's two readings of its own work (landCheck.ts): what main's check made of its latest land, and what its last
// turn showed. `compact` is the rail row's line, glyphs with their words in the hover, since that row is a button and
// a narrow one; the board card spells each out and can offer the conversation a red was handed to.

const t = useT();

const props = defineProps<{
    checks: CardChecks;
    compact?: boolean;
    // A receipt card (AgentCard): a pass is history there, so it takes the row's ink instead of green.
    quiet?: boolean;
}>();

// The one mark that moves with the clock, so only this leaf redraws while a check runs.
const now = useNow(() => props.checks.land?.kind === `checking`);

interface Mark {
    readonly key: string;
    readonly icon: IconName;
    readonly spin?: boolean;
    readonly tone: string;
    // Always said: beside the glyph on the board, as the glyph's name on the rail.
    readonly label: string;
    // Beside the glyph on the rail too; undefined leaves the rail with the glyph alone.
    readonly short?: string;
    readonly hint: string;
    // The conversation a red was handed to, offered where the card can host a press of its own.
    readonly open?: string;
}

const success = computed(() => (props.quiet === true ? `text-muted` : `text-success`));

const failuresOf = (count: number): string => t(`agents.mainline.failures`, { count }, count);

const landMark = (land: LandCheck, at: number): Mark => {
    const project = projectName(land.project);
    if (land.kind === `checking`) {
        const elapsed = formatElapsed(land.since, at);
        return {
            key: `land`,
            icon: `spinner`,
            spin: true,
            tone: `text-link`,
            label: `${t(`agents.landCheck.checking`)} · ${elapsed}`,
            short: elapsed,
            hint: t(`agents.landCheck.checkingHint`, { project }),
        };
    }
    if (land.kind === `waiting`) {
        return { key: `land`, icon: `clock`, tone: `text-muted`, label: t(`agents.landCheck.waiting`), hint: t(`agents.landCheck.waitingHint`, { project }) };
    }
    if (land.kind === `passed`) {
        return {
            key: `land`,
            icon: `shield`,
            tone: success.value,
            label: t(`agents.landCheck.passed`),
            hint: t(`agents.landCheck.passedHint`, { project, time: sinceWhen(land.since) }),
        };
    }
    if (land.kind === `checked-red`) {
        return { key: `land`, icon: `shield`, tone: `text-muted`, label: t(`agents.landCheck.checkedRed`), hint: t(`agents.landCheck.checkedRedHint`, { project }) };
    }
    const failures = land.failures ?? 0;
    const routing = routingMeta(land.routing);
    const broke = failures > 0 ? t(`agents.landCheck.broke`, { count: failures }) : t(`agents.landCheck.brokeMain`);
    const label = land.routing === undefined || routing.short === undefined ? broke : `${broke} · ${routing.short}`;
    return {
        key: `land`,
        icon: `exclamation-circle`,
        tone: `text-danger`,
        label,
        short: label,
        hint:
            failures > 0
                ? t(`agents.landCheck.brokeHint`, { project, failures: failuresOf(failures), routing: routing.words })
                : t(`agents.landCheck.brokeHintBare`, { project, routing: routing.words }),
        ...(land.fixUp === undefined ? {} : { open: land.fixUp }),
    };
};

const proofMarks = (proof: ProofMark): Mark[] => {
    const marks: Mark[] = [];
    if (proof.verification === `failing`) {
        marks.push({
            key: `verification`,
            icon: `exclamation-circle`,
            tone: `text-danger`,
            label: t(`agents.landCheck.lastCheckFailed`),
            hint: proof.check === undefined ? t(`agents.landCheck.lastCheckFailedHintBare`) : t(`agents.landCheck.lastCheckFailedHint`, { check: proof.check }),
        });
    } else if (proof.verification === `unproven`) {
        marks.push({
            key: `verification`,
            icon: `exclamation-triangle`,
            tone: `text-warning`,
            label: t(`agents.landCheck.unverified`),
            hint: t(`agents.landCheck.unverifiedHint`),
        });
    } else if (proof.verification === `verified`) {
        marks.push({
            key: `verification`,
            icon: `check`,
            tone: success.value,
            label: t(`agents.landCheck.verified`),
            hint: proof.check === undefined ? t(`agents.landCheck.verifiedHintBare`) : t(`agents.landCheck.verifiedHint`, { check: proof.check }),
        });
    }
    if (proof.unviewed !== undefined) {
        const label = t(`agents.landCheck.unviewed`, { count: proof.unviewed }, proof.unviewed);
        marks.push({ key: `unviewed`, icon: `eye-slash`, tone: `text-warning`, label, short: String(proof.unviewed), hint: label });
    }
    return marks;
};

// Main's verdict first: it is about work already in the tree, the proof only about how the turn left it.
const marks = computed<Mark[]>(() => [
    ...(props.checks.land === undefined ? [] : [landMark(props.checks.land, now.value)]),
    ...(props.checks.proof === undefined ? [] : proofMarks(props.checks.proof)),
]);
</script>

<template>
    <!-- The rail's marks name themselves only to a screen reader and in the hover (role="img"); the board's say it in words. -->
    <span v-if="compact" class="inline-flex shrink-0 items-center gap-2">
        <span
            v-for="mark in marks"
            :key="mark.key"
            :data-check="mark.key"
            role="img"
            :aria-label="mark.label"
            v-tooltip.top="mark.hint"
            class="inline-flex shrink-0 items-center gap-1"
            :class="mark.tone"
        >
            <Icon :name="mark.icon" :spin="mark.spin" class="shrink-0 text-2xs" />
            <span v-if="mark.short !== undefined" class="tabular-nums">{{ mark.short }}</span>
        </span>
    </span>
    <span v-else class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
        <span v-for="mark in marks" :key="mark.key" :data-check="mark.key" class="inline-flex min-w-0 items-center gap-1">
            <span v-tooltip.top="mark.hint" class="inline-flex min-w-0 items-center gap-1" :class="mark.tone">
                <Icon :name="mark.icon" :spin="mark.spin" class="shrink-0 text-2xs" />
                <span class="min-w-0 tabular-nums">{{ mark.label }}</span>
            </span>
            <button
                v-if="mark.open !== undefined"
                type="button"
                :class="ui.iconButton(`h-4 w-4`)"
                :aria-label="t(`agents.landCheck.openFixUp`)"
                v-tooltip.top="t(`agents.landCheck.openFixUp`)"
                @click.stop="openLandConversation(mark.open)"
            >
                <Icon name="arrow-right" class="text-2xs" />
            </button>
        </span>
    </span>
</template>
