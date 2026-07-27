<script setup lang="ts">
import type { AutomationRun, AutomationSummary } from "@intentic/sandbox-contract";
import { CopyButton, Icon, StatusBadge, type StatusVariant, ToggleSwitch } from "@intentic/extension-ui";
import { computed } from "vue";
import { formatAt, scheduleLabel } from "./cronSchedule";
import { webhookUrl } from "./useAutomations";

/* One automation, as a row: what fires it, what it last did, and the three things you can do to it (enable,
 * read its run history, delete). Shared by both shelves on the Automations page — the code chores and the
 * integrations — because an enabled chore IS an ordinary automation and must not grow a second presentation
 * that can drift from it. */

const props = defineProps<{ automation: AutomationSummary; expanded: boolean; busy?: boolean }>();
const emit = defineEmits<{ toggle: [enabled: boolean]; remove: []; history: [] }>();

// What fires this row, in one chip. A workspace trigger names a moment in the fleet's own work rather than a
// clock or an external sender, so it reads as the moment itself.
const triggerLabel = computed<string>(() => {
    const trigger = props.automation.trigger;
    if (trigger.kind === `schedule`) {
        return scheduleLabel(trigger.cron);
    }
    if (trigger.kind === `event`) {
        return `event`;
    }
    if (trigger.kind === `workspace`) {
        const when = trigger.event === `turn.settled` ? `when a turn settles` : `when work lands`;
        return trigger.repo !== undefined ? `${when} · ${trigger.repo}` : when;
    }
    return `live · ${trigger.provider}${trigger.eventType ? ` · ${trigger.eventType}` : ``}${trigger.mentioned ? ` · mentions` : ``}`;
});

const outcomeLabel = (run: AutomationRun): string => (run.outcome === `skipped` ? `Skipped by guard` : run.outcome);
const outcomeVariant = (outcome: string): StatusVariant => (outcome === `completed` ? `success` : outcome === `error` ? `danger` : `warning`);
</script>

<template>
    <div class="rounded-lg border border-line bg-canvas">
        <div class="flex items-center justify-between gap-3 px-3 py-2">
            <div class="min-w-0">
                <div class="flex items-center gap-2">
                    <span class="truncate font-medium text-content">{{ automation.id }}</span>
                    <span class="rounded bg-overlay px-1.5 py-0.5 text-2xs text-muted">{{ triggerLabel }}</span>
                    <CopyButton
                        v-if="automation.trigger.kind === 'event'"
                        :text="webhookUrl(automation) ?? ''"
                        :aria-label="`Copy webhook URL for ${automation.id}`"
                        v-tooltip.top="'Copy webhook URL'"
                    />
                    <Icon name="shield" v-if="automation.guard" v-tooltip.top="`Guarded: ${automation.guard}`" class="text-2xs text-subtle" />
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
                    :disabled="busy"
                    :aria-label="`Enable ${automation.id}`"
                    @update:model-value="emit('toggle', $event)"
                />
                <button
                    type="button"
                    class="text-muted hover:text-content"
                    :aria-label="`Run history for ${automation.id}`"
                    v-tooltip.top="'Run history'"
                    @click="emit('history')"
                >
                    <Icon name="history" class="text-sm" />
                </button>
                <button
                    type="button"
                    class="text-muted hover:text-danger"
                    :aria-label="`Delete ${automation.id}`"
                    v-tooltip.top="'Delete'"
                    @click="emit('remove')"
                >
                    <Icon name="trash" class="text-sm" />
                </button>
            </div>
        </div>

        <div v-if="expanded" class="border-t border-line px-3 py-2">
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
</template>
