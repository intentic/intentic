<script setup lang="ts">
import type { S2sContactTask } from "@intentic/sandbox-contract/schemas/s2s";
import { Button, Notice, StatusBadge, type StatusVariant } from "@intentic/ui";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { RouterLink } from "vue-router";
import { here, page } from "../../../../lib/routes/links";
import { taskName } from "../../../../models/messages/messagesView";
import { taskKey, useTaskDecision } from "../../../../models/messages/useTaskDecision";

// THE TASKS ONE CONTACT HANDED THIS SANDBOX, inside its opened row: what waits for the owner first (answered here too,
// since the push that says one waits opens this contact), then what runs, then what settled, each with its state, when it
// last moved, and the conversation it opened here. Allow and Decline are a maintainer's, as the daemon floors them.

defineProps<{ tasks: readonly S2sContactTask[]; manages: boolean }>();

const t = useT();
const { deciding, notice, decide } = useTaskDecision();

const STATES = {
    held: { variant: `warning`, label: () => t(`sandbox.messages.tasks.state.held`) },
    running: { variant: `info`, label: () => t(`sandbox.messages.tasks.state.running`) },
    finished: { variant: `success`, label: () => t(`sandbox.messages.tasks.state.finished`) },
    failed: { variant: `danger`, label: () => t(`sandbox.messages.tasks.state.failed`) },
    declined: { variant: `neutral`, label: () => t(`sandbox.messages.tasks.state.declined`) },
    stopped: { variant: `neutral`, label: () => t(`sandbox.messages.tasks.state.stopped`) },
} as const satisfies Record<S2sContactTask[`state`], { readonly variant: StatusVariant; readonly label: () => string }>;
</script>

<template>
    <div class="flex flex-col gap-1.5" data-contact-tasks>
        <span class="text-2xs text-subtle">{{ t(`sandbox.messages.tasks.onContact`) }}</span>
        <ul class="flex flex-col divide-y divide-line">
            <li v-for="task in tasks" :key="taskKey(task)" class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5" :data-contact-task="task.requestId">
                <span class="min-w-0 flex-1 truncate text-sm text-content">{{ taskName(task) ?? t(`sandbox.messages.tasks.aTask`) }}</span>
                <StatusBadge :variant="STATES[task.state].variant" :label="STATES[task.state].label()" size="xs" />
                <span class="text-2xs text-subtle">{{ timeAgo(task.updatedAt, { days: true }) }}</span>
                <template v-if="task.state === `held` && manages">
                    <Button
                        :label="t(`sandbox.messages.tasks.decline`)"
                        size="small"
                        tier="quiet"
                        tone="danger"
                        :disabled="deciding !== undefined"
                        @click="decide(task, false)"
                    />
                    <Button
                        tier="accent"
                        size="small"
                        :label="t(`sandbox.messages.tasks.allow`)"
                        :loading="deciding === taskKey(task)"
                        :disabled="deciding !== undefined"
                        @click="decide(task, true)"
                    />
                </template>
                <Button v-else size="small" tier="quiet" :as="RouterLink" :to="here(page.agent(task.conversationId))" data-task-conversation>
                    {{ t(`ui.action.open`) }}
                    <Icon name="arrow-up-right" class="text-2xs" />
                </Button>
            </li>
        </ul>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
