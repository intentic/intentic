<script setup lang="ts">
import { computed } from "vue";
import { Card, ui, Notice, type NoticeModel } from "@intentic/ui";
import Button from "primevue/button";
import PlanStepRow from "../../components/PlanStepRow.vue";
import { ProgressRing } from "@intentic/ui";
import type { useApplyProgress } from "./useApplyProgress";

/* The live apply progress, replacing the old spinner + "follow progress in the terminal": per-resource rows
 * (creating → created), readiness gates with their URL as services come up, and the convergence summary — all
 * from the useApplyProgress instance InfraDeclare owns (fed by the durable /intentic/apply/events tail, so it
 * survives a refresh). The terminal stays the detailed log surface, reachable via "View logs". */
const { progress } = defineProps<{ progress: ReturnType<typeof useApplyProgress> }>();
const { applying, reattaching, error, nodes, readiness, iterations, prunes, orphans, converged, applyPhaseDone, progressPct } = progress;
// The runner reports a bare message and no idea what it was applying; this card does.
const applyNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Applying your changes failed.`, detail: error.value },
);
</script>

<template>
    <Card class="flex w-full max-w-xl flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
                <ProgressRing v-if="applying && nodes.length > 0" :value="progressPct" :size="18" class="text-info" />
                <Icon v-else-if="applying" name="spinner" spin class="text-info" />
                <Icon v-else-if="error" name="exclamation-triangle" class="text-danger" />
                <Icon v-else name="check-circle" class="text-success" />
                <span class="text-sm font-medium text-content">
                    {{ error ? "Apply failed" : applying ? (applyPhaseDone ? "Finishing up…" : "Applying changes…") : "Applied" }}
                </span>
            </div>
            <Button label="View logs" size="small" severity="secondary" :text="true" @click="progress.viewLogs()">
                <template #icon><Icon name="window-maximize" /></template>
            </Button>
        </div>

        <!-- The progress stream dropped and is being re-opened — the job itself is unaffected (it runs in tmux). -->
        <p v-if="reattaching" class="flex items-center gap-1.5 text-2xs text-warning">
            <Icon name="refresh" spin /> Progress stream dropped — reconnecting… (the apply itself keeps running)
        </p>

        <!-- Per-resource apply progress: a spinner + present-tense label while in flight, the action badge once done. -->
        <div v-if="nodes.length > 0" class="flex flex-col gap-1.5">
            <PlanStepRow
                v-for="node in nodes"
                :key="node.id"
                :id="node.id"
                :action="node.action ?? 'noop'"
                :reason="node.reason"
                context="plan"
                :pending="node.state === 'start'"
            />
        </div>

        <!-- Readiness gates: services coming up, each with its URL once live. -->
        <div v-if="readiness.length > 0" class="flex flex-col gap-1.5">
            <div
                v-for="gate in readiness"
                :key="gate.id"
                class="flex items-center justify-between gap-2 rounded-md border border-line bg-canvas px-3 py-1.5"
            >
                <span class="flex min-w-0 items-center gap-1.5">
                    <Icon v-if="gate.state === 'waiting'" name="spinner" spin class="shrink-0 text-info" />
                    <Icon v-else name="check-circle" class="shrink-0 text-success" />
                    <span class="truncate font-mono text-2xs text-content">{{ gate.id }}</span>
                </span>
                <a
                    v-if="gate.url"
                    :href="gate.url"
                    target="_blank"
                    rel="noopener"
                    class="shrink-0 truncate font-mono text-2xs text-link hover:underline"
                >
                    {{ gate.url }}
                </a>
            </div>
        </div>

        <!-- Prunes (removed resources) + orphans (live but no longer declared). -->
        <div v-if="prunes.length > 0" class="flex flex-col gap-1.5">
            <PlanStepRow
                v-for="prune in prunes"
                :key="prune.id"
                :id="prune.id"
                action="delete"
                :reason="prune.state === 'skipped' ? 'left in place' : prune.reason"
                context="plan"
            />
        </div>
        <p v-if="orphans.length > 0" class="text-2xs text-warning">Not in your intent: {{ orphans.map((orphan) => orphan.id).join(", ") }}</p>

        <p v-if="applyPhaseDone && converged !== undefined && !error" class="text-xs" :class="converged ? 'text-success' : 'text-warning'">
            {{
                converged
                    ? `Converged in ${iterations.length} iteration${iterations.length === 1 ? "" : "s"}.`
                    : "Didn't fully converge — a re-apply may be needed."
            }}
        </p>

        <Notice v-if="applyNotice" :of="applyNotice" />
    </Card>
</template>
