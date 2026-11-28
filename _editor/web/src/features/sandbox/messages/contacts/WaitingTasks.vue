<script setup lang="ts">
import type { S2sContactTask } from "@intentic/sandbox-contract/schemas/s2s";
import { Avatar, Button, Notice, Row, RowGroup, RowNote } from "@intentic/ui";
import { timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { identityHue } from "../../../../lib/identityHue";
import { taskName } from "../../../../models/messages/messagesView";
import { taskKey, useTaskDecision } from "../../../../models/messages/useTaskDecision";

// TASKS WAITING FOR THE OWNER, beside the contact requests at the top of Contacts: each a task a contact handed this
// sandbox under a `task` grant that says to ask first (docs/architecture/messages.md, "Waiting for the owner"). Its name,
// who asked and when, and its words as the asker wrote them (plain text, cut by the daemon), since that is what Allow
// lets run. Allow starts it now; Decline ends it with nothing of it run. Both are a maintainer's, as the daemon floors them.

defineProps<{ tasks: readonly S2sContactTask[]; manages: boolean }>();

const t = useT();
const { deciding, notice, decide } = useTaskDecision();
</script>

<template>
    <RowGroup :label="t(`sandbox.messages.tasks.waitingTitle`)" data-waiting-tasks>
        <Row
            v-for="task in tasks"
            :key="taskKey(task)"
            lead="face"
            :title="taskName(task) ?? t(`sandbox.messages.tasks.aTask`)"
            :description="t(`sandbox.messages.tasks.from`, { name: task.contactName })"
            :data-waiting-task="task.requestId"
        >
            <template #lead="{ mark }">
                <Avatar :size="mark" :name="task.contactName" :hue="identityHue(task.contact)" />
            </template>
            <template #meta>{{ t(`sandbox.messages.tasks.asked`, { ago: timeAgo(task.askedAt, { days: true }) }) }}</template>
            <template v-if="manages" #control>
                <Button
                    :label="t(`sandbox.messages.tasks.decline`)"
                    size="small"
                    tier="quiet"
                    tone="danger"
                    :disabled="deciding !== undefined"
                    data-decline
                    @click="decide(task, false)"
                />
                <Button
                    tier="accent"
                    size="small"
                    :label="t(`sandbox.messages.tasks.allow`)"
                    :loading="deciding === taskKey(task)"
                    :disabled="deciding !== undefined"
                    data-allow
                    @click="decide(task, true)"
                >
                    <template #icon><Icon name="check" /></template>
                </Button>
            </template>
            <template v-if="task.task || !manages" #below>
                <div class="flex flex-col gap-2">
                    <blockquote v-if="task.task" class="whitespace-pre-wrap break-words border-l-2 border-line-strong pl-3 text-sm text-content">{{ task.task }}</blockquote>
                    <p v-if="!manages" class="text-xs text-subtle">{{ t(`sandbox.messages.tasks.maintainerAnswers`) }}</p>
                </div>
            </template>
        </Row>
        <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>
    </RowGroup>
</template>
