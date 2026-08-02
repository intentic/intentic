<script setup lang="ts">
import { Card, cmp } from "@intentic/ui";
import Button from "primevue/button";
import { computed } from "vue";
import { type PlanStep, statusDot } from "../../composables/extensions/reconcileStatus";
import SecretField from "../../components/SecretField.vue";
import type { usePlanPreview } from "./usePlanPreview";

/* The pre-apply review: what applying the current wants WOULD do to the infra, grouped by verb (create /
 * update / remove) so a long plan scans as three counted sections instead of a per-resource chain (a want
 * stages here, it doesn't deploy). Reads the usePlanPreview instance InfraDeclare owns; folds in the
 * missing-secrets checklist that gates resolve → plan. */
const { preview } = defineProps<{ preview: ReturnType<typeof usePlanPreview> }>();
const { running, ran, stale, error, steps, orphans, activity, missingSecrets, awaitingSecrets } = preview;

// The three things a plan can do, in the order a reviewer cares: additions, changes, removals. Each section
// keys on a canonical action so statusDot stays the one color vocabulary.
const SECTIONS = [
    { action: `create`, matches: [`create`], label: `to create` },
    { action: `update`, matches: [`update`, `diff`], label: `to update` },
    { action: `delete`, matches: [`delete`, `prune`], label: `to remove` },
] as const;

interface ChangeSection {
    readonly action: string;
    readonly label: string;
    readonly steps: readonly PlanStep[];
}

// Bucket the plan's non-noop steps + orphans (as deletes) by action; empty buckets drop out. Dedupe by id
// within a bucket — a resource can arrive both as a prune step and in the result frame's orphan list. Orphans
// are the only authoritative "to remove" — the declared/live rollup can't see a want that was removed but is
// still running.
const sections = computed<ChangeSection[]>(() => {
    const all: PlanStep[] = [
        ...steps.value.filter((step) => step.action !== `noop`),
        ...orphans.value.map((orphan): PlanStep => ({ id: orphan.id, action: `delete` })),
    ];
    return SECTIONS.map(({ action, matches, label }) => {
        const bucket = new Map(all.filter((step) => (matches as readonly string[]).includes(step.action)).map((step) => [step.id, step]));
        return { action, label, steps: [...bucket.values()] };
    }).filter((section) => section.steps.length > 0);
});

const hasChanges = computed(() => sections.value.length > 0);
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
                <RouterLink to="/sandbox/secrets" class="text-link hover:underline">Sandbox Secrets</RouterLink>.
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
            <div v-if="hasChanges" class="flex flex-col gap-2">
                <!-- One section per verb: the header IS the summary (dot + count + verb), rows are just ids —
                     no per-row badge repetition. Big sections (e.g. a mass remove) start collapsed. -->
                <details v-for="section in sections" :key="section.action" class="group" :open="section.steps.length <= 8">
                    <summary class="flex cursor-pointer list-none items-center gap-2 py-0.5 [&::-webkit-details-marker]:hidden">
                        <Icon name="chevron-right" class="text-xs text-subtle transition-transform group-open:rotate-90" />
                        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="statusDot(section.action)"></span>
                        <span class="text-sm font-medium text-content">{{ section.steps.length }} {{ section.label }}</span>
                    </summary>
                    <div class="ml-1.5 mt-1.5 divide-y divide-line rounded-md border border-line bg-canvas">
                        <div v-for="step in section.steps" :key="step.id" class="px-3 py-1.5">
                            <span class="block truncate font-mono text-2xs text-content">{{ step.id }}</span>
                            <span v-if="step.reason" class="block truncate text-2xs text-muted">{{ step.reason }}</span>
                        </div>
                    </div>
                </details>
            </div>
            <p v-else class="flex items-center gap-2 text-sm text-success">
                <Icon name="check-circle" /> Everything is up to date — nothing to apply.
            </p>
            <p v-if="stale" class="text-2xs text-warning">Your wants changed since this preview — re-check to see the latest.</p>
        </template>

        <p v-else class="text-sm text-muted">Preview to see what applying your wants will create, update or remove — before anything changes.</p>
    </Card>
</template>
