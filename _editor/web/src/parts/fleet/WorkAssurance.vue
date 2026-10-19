<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { ProofMark } from "../../models/fleet/board/proofSeal";
import { FRESH_ICONS } from "../../models/fleet/freshKinds";
import { canStartFresh, type CheckMarker, draftFreshSession } from "../../models/fleet/freshSession";
import { useRole } from "../../client/sandbox/useRole";
import { computed } from "vue";
import { useAgents } from "../../models/fleet/useAgents";
import type { FleetAgent } from "../../models/fleet/useAgents-fleet";
import CardSeal from "./CardSeal.vue";

// WHAT HAS LOOKED AT A CARD'S WORK, in words, one marker each: what its own last turn checked (the seal with its reading
// beside it, CardSeal `labelled`), then every check a fresh session ran on it, the latest of each kind
// (freshSession.checksOf): a code review, a test pass, any kind added later. Only what happened is said; nothing nags
// for a check that never ran, since every check is optional. Each marker opens the chat it ran in, and one the work has
// moved past offers to run it again.

const t = useT();

const props = defineProps<{
    agent: FleetAgent;
    proof: ProofMark | undefined;
    checks: readonly CheckMarker[];
    // A receipt card: history, drawn in the corner's quiet ink.
    quiet: boolean;
}>();

const { agentById, open } = useAgents();
// A fresh session can be cut from this work now, by a reader who may start one: a stale or failed check offers Again.
const { canReview } = useRole();
const again = computed(() => canReview.value && canStartFresh(props.agent));

// What the marker says of where its check stands, after the kind's own name.
const stateOf = (check: CheckMarker): string => {
    if (check.state === `findings`) {
        const count = check.findings ?? 0;
        const left = check.open ?? count;
        return left < count
            ? t(`agents.workAssurance.state.open`, { open: left, count })
            : t(`agents.workAssurance.state.findings`, { count }, count);
    }
    return t(`agents.workAssurance.state.${check.state}`);
};

// Open findings are news even on a receipt; a failure always is; a stale or settled check is said quietly.
const toneOf = (check: CheckMarker): string => {
    if (check.state === `failed`) {
        return `text-danger`;
    }
    if (check.state === `running`) {
        return `text-link`;
    }
    if (check.stale) {
        return `text-faint`;
    }
    if (check.state === `findings` && (check.open ?? check.findings ?? 0) > 0) {
        return `text-warning`;
    }
    return check.state === `clean` && !props.quiet ? `text-success` : `text-faint`;
};

// Where it ran: a fresh session read only the work; the agent's own chat had read how it was made.
const tipOf = (check: CheckMarker) => ({
    title: t(`agents.workAssurance.openTitle`),
    note: check.own ? t(`agents.workAssurance.ownTip`) : t(`agents.workAssurance.freshTip`),
});

const offersAgain = (check: CheckMarker): boolean => again.value && (check.stale || check.state === `failed`);

const openCheck = (check: CheckMarker): void => {
    const card = agentById(check.by);
    if (card !== undefined) {
        open(card, `peek`);
    }
};
const runAgain = (check: CheckMarker): void => void draftFreshSession(props.agent, check.kind);
</script>

<template>
    <p class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs leading-4" data-work-assurance>
        <CardSeal v-if="proof !== undefined" :proof="proof" :quiet="quiet" labelled class="max-w-full" />
        <span v-for="check in checks" :key="check.kind" class="flex min-w-0 items-center gap-1.5" data-check :data-check-kind="check.kind">
            <button
                type="button"
                class="flex min-w-0 cursor-pointer items-center gap-1 rounded-sm text-muted hover:text-content"
                v-tooltip.top="tipOf(check)"
                :data-check-state="check.state"
                @click.stop="openCheck(check)"
            >
                <Icon
                    :name="check.state === `running` ? `spinner` : FRESH_ICONS[check.kind]"
                    :spin="check.state === `running`"
                    class="shrink-0 text-2xs"
                    :class="toneOf(check)"
                />
                <span class="min-w-0 truncate">{{
                    t(`agents.workAssurance.marker`, { kind: t(`agents.freshSession.kind.${check.kind}`), state: stateOf(check) })
                }}</span>
                <span v-if="check.stale" class="shrink-0 text-subtle">· {{ t(`agents.workAssurance.stale`) }}</span>
            </button>
            <button
                v-if="offersAgain(check)"
                type="button"
                :class="ui.textButton({ size: `xs`, flush: true }, `shrink-0 font-medium`)"
                v-tooltip.top="{ title: t(`agents.workAssurance.againTitle`), note: t(`agents.workAssurance.againNote`) }"
                data-check-again
                @click.stop="runAgain(check)"
            >
                {{ t(`agents.workAssurance.again`) }}
            </button>
        </span>
    </p>
</template>
