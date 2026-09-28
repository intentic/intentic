<script setup lang="ts">
import { Button, Code, Icon, timeAgo } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { usePushFlow } from "../../features/workspace/push/usePushFlow";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* WHAT THE PUSH QUESTION CARRIES THAT TWO STRINGS CANNOT: the command in monospace, and the way back to the terminal it all came out of. */

const pushFlow = usePushFlow();

/* A CARD THAT IS NOT NEWS SAYS SO: raised once when the push is refused, and again on every reopen. */
const clock = useNow(() => pushFlow.fromMemory.value);
const memoryLine = computed<string | undefined>(() => {
    const at = pushFlow.verdictAt.value;
    if (!pushFlow.fromMemory.value || at === undefined) {
        return undefined;
    }
    const when = `From ${timeAgo(at, { now: clock.value })}.`;
    return pushFlow.heldStale.value
        ? `${when} Files have changed since, so this may no longer be what happens.`
        : `${when} Nothing has changed since.`;
});
</script>

<template>
    <!-- ONE UNCONDITIONAL ROOT ELEMENT, so the lane's own class lands somewhere. -->
    <div>
        <!-- The command that failed in a 1-line syntax-highlighted code block. -->
        <div v-if="pushFlow.question.value" class="flex flex-col gap-1.5">
            <div v-if="pushFlow.question.value.command" class="checks-command flex min-w-0 items-center rounded-md border border-line bg-canvas">
                <Code class="min-w-0 flex-1" :code="pushFlow.question.value.command" lang="bash" :copyable="false" />
            </div>
            <p v-if="pushFlow.question.value.detail" class="break-words text-2xs text-muted">
                {{ pushFlow.question.value.detail }}
            </p>
            <!-- Only on a reprint: a card reporting a run that just ended dates itself by being here. -->
            <p v-if="memoryLine" class="break-words text-2xs text-subtle">{{ memoryLine }}</p>
        </div>

        <!-- ONE ROW: the way back to the output on the left, the answer on the right. -->
        <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
            <!-- The way back to what actually happened, not an answer to the question. -->
            <div class="mr-auto flex items-center gap-3">
                <button
                    v-if="pushFlow.terminal.value !== undefined"
                    type="button"
                    class="flex items-center gap-1.5 rounded text-2xs text-muted transition-colors hover:text-content"
                    @click="pushFlow.showTerminal"
                >
                    <Icon name="terminal" class="text-2xs" />
                    {{ t(`shell.pushQuestionBody.showTerminal`) }}
                </button>
            </div>

            <!-- The same push again, hook and all. -->
            <Button size="small" severity="warn" :label="t(`ui.action.tryAgain`)" @click="pushFlow.retry" />
        </div>
    </div>
</template>

<style scoped>
.checks-command :deep(.shiki),
.checks-command :deep(pre) {
    border: 0;
    background-color: transparent !important;
}
</style>
