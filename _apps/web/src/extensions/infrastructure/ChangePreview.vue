<script setup lang="ts">
import { Card, cmp } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed } from "vue";
import PlanStepRow from "../../components/PlanStepRow.vue";
import type { PlanStep } from "../../composables/extensions/reconcileStatus";
import SecretField from "../../components/SecretField.vue";
import type { usePlanPreview } from "./usePlanPreview";
import { appName } from "./wanted";

/* The pre-apply review: what applying the current wants WOULD do to the infra, grouped by want, so the user
 * sees the changes before committing them (a want stages here, it doesn't deploy). Reads the usePlanPreview
 * instance InfraDeclare owns; folds in the missing-secrets checklist that gates resolve → plan. */
const { preview } = defineProps<{ preview: ReturnType<typeof usePlanPreview> }>();
const { running, ran, stale, error, steps, orphans, activity, missingSecrets, awaitingSecrets } = preview;

interface WantChanges {
    readonly name: string;
    readonly steps: readonly PlanStep[];
}

// Group the plan's non-noop steps + orphans (as deletes) by want name ("shop.production" → "shop"); a want
// whose resources are all in sync drops out. Orphans are the only authoritative "to remove" — the declared/
// live rollup can't see a want that was removed but is still running.
const changes = computed<WantChanges[]>(() => {
    const byWant = new Map<string, PlanStep[]>();
    const push = (id: string, step: PlanStep): void => {
        const name = appName(id);
        const list = byWant.get(name) ?? [];
        list.push(step);
        byWant.set(name, list);
    };
    for (const step of steps.value) {
        if (step.action !== `noop`) {
            push(step.id, step);
        }
    }
    for (const orphan of orphans.value) {
        push(orphan.id, { id: orphan.id, action: `delete` });
    }
    return [...byWant].map(([name, list]) => ({ name, steps: list }));
});

const hasChanges = computed(() => changes.value.length > 0);

// A per-want one-liner: "1 to create · 2 to update · 1 to remove".
const summarize = (list: readonly PlanStep[]): string => {
    const count = (...actions: string[]): number => list.filter((step) => actions.includes(step.action)).length;
    return [
        [count(`create`), `to create`],
        [count(`update`, `diff`), `to update`],
        [count(`delete`, `prune`), `to remove`],
    ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, label]) => `${n} ${label}`)
        .join(` · `);
};
</script>

<template>
    <Card class="flex w-full max-w-xl flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
                <Icon name="list-check" class="text-subtle" />
                <span class="text-sm font-medium text-content">Planned changes</span>
            </div>
            <Button
                :label="ran && !stale ? 'Re-check' : 'Preview changes'"
                size="small"
                severity="secondary"
                :outlined="true"
                :disabled="running"
                :loading="running"
                @click="preview.run()"
            >
                <template #icon><Icon name="refresh" /></template>
            </Button>
        </div>

        <!-- resolve paused on required-but-unset secrets: set them inline, then continue to the plan. -->
        <template v-if="awaitingSecrets">
            <div class="flex items-center gap-2">
                <Icon name="key" class="text-warning" />
                <span class="text-sm font-medium text-content">
                    Set {{ missingSecrets.length }} secret{{ missingSecrets.length === 1 ? `` : `s` }} to preview the change
                </span>
            </div>
            <p class="text-xs text-muted">
                Your intent declares secrets that aren't in your sandbox yet. Manage them any time on the
                <RouterLink to="/secrets" class="text-link hover:underline">Secrets page</RouterLink>.
            </p>
            <div v-for="key in missingSecrets" :key="key" class="flex flex-col gap-1">
                <span class="font-mono text-xs text-content">{{ key }}</span>
                <SecretField :secret-key="key" no-hint />
            </div>
            <div class="flex justify-end">
                <Button label="Continue" :disabled="missingSecrets.length > 0 || running" :loading="running" @click="preview.continueAfterSecrets()">
                    <template #icon><Icon name="arrow-right" /></template>
                </Button>
            </div>
        </template>

        <div v-else-if="error" :class="cmp.alertDanger()">{{ error }}</div>

        <!-- Live narration of the run (which node is being checked) + a way OUT — never a dead-end spinner. -->
        <div v-else-if="running" class="flex items-center justify-between gap-2">
            <p class="flex min-w-0 items-center gap-2 text-sm text-muted">
                <Icon name="spinner" spin class="shrink-0 text-info" />
                <span class="truncate">{{ activity ?? "Working out what will change…" }}</span>
            </p>
            <Button label="Cancel" size="small" severity="secondary" :text="true" @click="preview.cancel()" />
        </div>

        <template v-else-if="ran">
            <div v-if="hasChanges" class="flex flex-col gap-3">
                <div v-for="group in changes" :key="group.name" class="flex flex-col gap-1.5">
                    <div class="flex items-baseline justify-between gap-2">
                        <span class="truncate text-sm font-medium text-content">{{ group.name }}</span>
                        <span class="shrink-0 text-2xs text-subtle">{{ summarize(group.steps) }}</span>
                    </div>
                    <PlanStepRow
                        v-for="step in group.steps"
                        :key="step.id"
                        :id="step.id"
                        :action="step.action"
                        :reason="step.reason"
                        context="plan"
                    />
                </div>
            </div>
            <p v-else class="flex items-center gap-2 text-sm text-success">
                <Icon name="check-circle" /> Everything is up to date — nothing to apply.
            </p>
            <p v-if="stale" class="text-2xs text-warning">Your wants changed since this preview — re-check to see the latest.</p>
        </template>

        <p v-else class="text-sm text-muted">Preview to see what applying your wants will create, update or remove — before anything changes.</p>
    </Card>
</template>
