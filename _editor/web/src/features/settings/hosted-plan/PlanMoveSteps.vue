<!-- A CLOUD SANDBOX RESTARTING ONTO ITS NEW PLAN, step by step: paid, snapshot, resize, start, the one under way marked,
     how long it has run, and that the sandbox is offline until it is done. Drawn where the plan is read (the sandbox's
     Plan card, its gate while it cannot be reached, Billing's row), so leaving one of them never loses the restart. The
     plan state is read every few seconds meanwhile (useHostedPlan.ts), which is what moves the steps. -->
<script setup lang="ts">
import { useNow } from "@intentic/ui/async";
import { formatDuration } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { PlanMove } from "../../../models/hosted-plan/planMoves";
import { moveSteps } from "./planChange";

const { move, from, comped = false, name, note = true } = defineProps<{
    move: Extract<PlanMove, { kind: `moving` }>;
    /** The plan it is moving from. */
    from: string;
    comped?: boolean;
    /** The sandbox's name, for the line under the steps. */
    name: string;
    /** The line under the steps; off where the surface already says the sandbox is offline. */
    note?: boolean;
}>();

const t = useT();
const now = useNow();
const steps = computed(() => moveSteps(move, from, comped));
const elapsed = computed(() => formatDuration(Math.max(0, (now.value - Date.parse(move.since)) / 1000)));
</script>

<template>
    <div class="flex flex-col gap-2" data-plan-move>
        <div class="flex items-start gap-3">
            <ol class="flex min-w-0 flex-1 flex-wrap gap-x-4 gap-y-1 text-xs" role="list">
                <li
                    v-for="step in steps"
                    :key="step.key"
                    class="inline-flex items-center gap-1.5"
                    :class="step.state === `done` ? `text-success` : step.state === `active` ? `font-medium text-content` : `text-subtle`"
                    :aria-current="step.state === `active` ? `step` : undefined"
                >
                    <Icon
                        :name="step.state === `done` ? `check` : step.state === `active` ? `spinner` : `circle`"
                        :spin="step.state === `active`"
                        class="shrink-0 text-2xs"
                        :class="step.state === `active` ? `text-accent` : ``"
                    />
                    {{ step.label }}
                </li>
            </ol>
            <span class="shrink-0 text-2xs text-subtle tabular-nums">{{ elapsed }}</span>
        </div>
        <p v-if="note" class="text-xs text-muted">{{ t(`settings.plans.movingNote`, { name }) }}</p>
    </div>
</template>
