<script setup lang="ts">
import type { AutomationRun, AutomationSummary } from "@intentic/sandbox-contract";
import { Button, Card, cmp, CopyButton, Icon, Page, PageHeader, StatusBadge, type StatusVariant, ToggleSwitch } from "@intentic/extension-ui";
import { computed, reactive, ref } from "vue";
import CreateAutomationDialog from "./CreateAutomationDialog.vue";
import { formatAt, scheduleLabel } from "./cronSchedule";
import { useAutomations, webhookUrl } from "./useAutomations";

/* Automations: agent wake-ups, native to every sandbox (no capability to enable). One automation = trigger
 * (cron, webhook, or a live listener on the daemon's provider connection) → optional guard (a shell command
 * the daemon runs in the workspace first; non-zero exit skips the wake) → the prompt the agent wakes with.
 * The daemon fires them and records the run history. This view is the list + approval queue; creating one
 * lives in CreateAutomationDialog. */

const { automations, pending, error: listError, save, remove, approve, reject } = useAutomations();

const createOpen = ref(false);
// List-action errors (toggle/delete/approve/reject) — the dialog carries its own submit error.
const actionError = ref<string | null>(null);
// Rows with their run history unfolded.
const expanded = reactive(new Set<string>());

const topError = computed(() => actionError.value ?? listError.value);

// The enabled toggle is a plain re-post of the automation with the flag flipped (upsert keeps the run history).
const toggle = async (automation: AutomationSummary, enabled: boolean): Promise<void> => {
    actionError.value = null;
    try {
        await save.mutateAsync({
            id: automation.id,
            trigger: automation.trigger,
            ...(automation.guard !== undefined ? { guard: automation.guard } : {}),
            prompt: automation.prompt,
            ...(automation.agent !== undefined ? { agent: automation.agent } : {}),
            ...(automation.harness !== undefined ? { harness: automation.harness } : {}),
            ...(automation.model !== undefined ? { model: automation.model } : {}),
            ...(automation.requireApproval !== undefined ? { requireApproval: automation.requireApproval } : {}),
            enabled,
        });
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not update the automation.`;
    }
};

const removeAutomation = async (id: string): Promise<void> => {
    actionError.value = null;
    try {
        await remove.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not remove the automation.`;
    }
};

// Approve a held wake (the agent runs now) or reject it (dropped, never runs).
const approvePending = async (id: string): Promise<void> => {
    actionError.value = null;
    try {
        await approve.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not approve the automation.`;
    }
};
const rejectPending = async (id: string): Promise<void> => {
    actionError.value = null;
    try {
        await reject.mutateAsync(id);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `Could not reject the automation.`;
    }
};

const toggleHistory = (id: string): void => {
    if (!expanded.delete(id)) {
        expanded.add(id);
    }
};

// The prompt of the automation a pending approval belongs to, for a preview line (undefined if it was deleted).
const pendingPrompt = (automationId: string): string | undefined => automations.value.find((automation) => automation.id === automationId)?.prompt;
const outcomeLabel = (run: AutomationRun): string => (run.outcome === `skipped` ? `Skipped by guard` : run.outcome);
const outcomeVariant = (outcome: string): StatusVariant => (outcome === `completed` ? `success` : outcome === `error` ? `danger` : `warning`);
</script>

<template>
    <Page width="wide">
        <PageHeader
            title="Automations"
            description="Wake your agent on a schedule, on a webhook, or instantly from live provider events. An optional guard command runs in your workspace first and decides whether each wake actually happens."
        />

        <div v-if="topError" :class="cmp.alertDanger('mb-3')">{{ topError }}</div>

        <Card v-if="pending.length > 0" class="mb-3 flex flex-col gap-3 border-warning/40">
            <div class="flex items-center gap-2.5">
                <Icon name="clock" class="text-lg text-warning" />
                <div>
                    <h2 class="font-semibold leading-tight">Pending approvals</h2>
                    <p class="text-xs text-muted">These automations fired but are waiting for you — the agent hasn't run yet.</p>
                </div>
            </div>
            <div class="flex flex-col gap-2">
                <div v-for="item in pending" :key="item.id" class="rounded-lg border border-line bg-canvas px-3 py-2">
                    <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                            <div class="flex items-center gap-2">
                                <span class="truncate font-medium text-content">{{ item.automationId }}</span>
                                <span class="rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">fired {{ formatAt(item.createdAt) }}</span>
                            </div>
                            <p v-if="pendingPrompt(item.automationId)" class="mt-0.5 truncate text-2xs text-subtle">
                                {{ pendingPrompt(item.automationId) }}
                            </p>
                            <p v-if="item.payload" class="mt-0.5 truncate font-mono text-2xs text-subtle" v-tooltip.top="item.payload">
                                {{ item.payload }}
                            </p>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                            <Button label="Approve" size="small" :disabled="approve.isPending.value" @click="approvePending(item.id)">
                                <template #icon><Icon name="check" /></template>
                            </Button>
                            <Button
                                label="Reject"
                                size="small"
                                severity="secondary"
                                :disabled="reject.isPending.value"
                                @click="rejectPending(item.id)"
                            >
                                <template #icon><Icon name="times" /></template>
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Card>

        <Card class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2.5">
                    <Icon name="clock" class="text-lg text-muted" />
                    <div>
                        <h2 class="font-semibold leading-tight">Scheduled wake-ups</h2>
                        <p class="text-xs text-muted">Each automation runs as a fresh agent session; its transcript appears with your chats.</p>
                    </div>
                </div>
                <Button label="New automation" size="small" @click="createOpen = true">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>

            <div v-if="automations.length === 0" :class="cmp.emptyState('py-6')">No automations yet — schedule your agent's first wake-up.</div>

            <div v-else class="flex flex-col gap-2">
                <div v-for="automation in automations" :key="automation.id" class="rounded-lg border border-line bg-canvas">
                    <div class="flex items-center justify-between gap-3 px-3 py-2">
                        <div class="min-w-0">
                            <div class="flex items-center gap-2">
                                <span class="truncate font-medium text-content">{{ automation.id }}</span>
                                <span class="rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">{{
                                    automation.trigger.kind === "schedule"
                                        ? scheduleLabel(automation.trigger.cron)
                                        : automation.trigger.kind === "event"
                                          ? "event"
                                          : `live · ${automation.trigger.provider}${automation.trigger.eventType ? ` · ${automation.trigger.eventType}` : ``}${automation.trigger.mentioned ? ` · mentions` : ``}`
                                }}</span>
                                <CopyButton
                                    v-if="automation.trigger.kind === 'event'"
                                    :text="webhookUrl(automation) ?? ''"
                                    :aria-label="`Copy webhook URL for ${automation.id}`"
                                    v-tooltip.top="'Copy webhook URL'"
                                />
                                <Icon
                                    name="shield"
                                    v-if="automation.guard"
                                    v-tooltip.top="`Guarded: ${automation.guard}`"
                                    class="text-2xs text-subtle"
                                />
                                <Icon
                                    name="lock"
                                    v-if="automation.requireApproval"
                                    v-tooltip.top="'Requires your approval before running'"
                                    class="text-2xs text-subtle"
                                />
                            </div>
                            <p class="mt-0.5 truncate text-2xs text-subtle">{{ automation.prompt }}</p>
                        </div>
                        <div class="flex shrink-0 items-center gap-3">
                            <StatusBadge
                                v-if="automation.runs[0]"
                                :variant="outcomeVariant(automation.runs[0].outcome)"
                                :label="outcomeLabel(automation.runs[0])"
                                size="xs"
                                v-tooltip.top="automation.runs[0].detail"
                            />
                            <span v-if="automation.nextRun" class="text-2xs text-subtle">next {{ formatAt(automation.nextRun) }}</span>
                            <ToggleSwitch
                                :model-value="automation.enabled"
                                :aria-label="`Enable ${automation.id}`"
                                @update:model-value="toggle(automation, $event)"
                            />
                            <button
                                type="button"
                                class="text-muted hover:text-content"
                                :aria-label="`Run history for ${automation.id}`"
                                v-tooltip.top="'Run history'"
                                @click="toggleHistory(automation.id)"
                            >
                                <Icon name="history" class="text-sm" />
                            </button>
                            <button
                                type="button"
                                class="text-muted hover:text-danger"
                                :aria-label="`Delete ${automation.id}`"
                                v-tooltip.top="'Delete'"
                                @click="removeAutomation(automation.id)"
                            >
                                <Icon name="trash" class="text-sm" />
                            </button>
                        </div>
                    </div>

                    <div v-if="expanded.has(automation.id)" class="border-t border-line px-3 py-2">
                        <p v-if="automation.runs.length === 0" class="text-xs text-muted">No runs yet.</p>
                        <div v-else class="flex flex-col gap-1">
                            <div v-for="run in automation.runs" :key="run.at" class="flex items-baseline gap-2 text-2xs">
                                <span class="shrink-0 font-mono text-subtle">{{ formatAt(run.at) }}</span>
                                <StatusBadge :variant="outcomeVariant(run.outcome)" :label="outcomeLabel(run)" size="xs" />
                                <span v-if="run.detail" class="truncate text-subtle" v-tooltip.top="run.detail">{{ run.detail }}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </Card>

        <CreateAutomationDialog v-model:visible="createOpen" />
    </Page>
</template>
