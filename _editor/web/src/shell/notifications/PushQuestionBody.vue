<script setup lang="ts">
import { AgentRunButton, Button, Code, fixStanceLook, Icon, timeAgo, useAgentRunPick } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { type ComponentPublicInstance, computed, ref } from "vue";
import { shellModelPicking } from "../../features/chat/models/shellModelPicking";
import { usePushFlow } from "../../features/workspace/push/usePushFlow";

/* WHAT THE PUSH QUESTION CARRIES THAT TWO STRINGS CANNOT: the command in monospace, and the way back to the terminal it all came out of. */

const pushFlow = usePushFlow();
// The attempt already on this failure rides into the picker, so its bar ends in Continue / Start over.
const fixModel = useAgentRunPick(
    () => shellModelPicking(),
    `pre-push-fix`,
    () => pushFlow.attemptOnOffer.value,
);

const pushAnywayLabel = computed(() => (pushFlow.question.value?.kind === `push` ? `Try again` : `${pushFlow.pending.value?.verb ?? `Push`} anyway`));

/* A CARD THAT IS NOT NEWS SAYS SO. This one is raised twice for the same failure: once when the suite settles,. */
const clock = useNow(() => pushFlow.fromMemory.value);
const memoryLine = computed<string | undefined>(() => {
    const at = pushFlow.verdictAt.value;
    if (!pushFlow.fromMemory.value || at === undefined) {
        return undefined;
    }
    const when = `From ${timeAgo(at, { now: clock.value })}.`;
    return pushFlow.heldStale.value ? `${when} Files have changed since, so this may no longer be what happens.` : `${when} Nothing has changed since.`;
});

// A red suite is the one failure a reader can legitimately doubt (flaky, or a fix landed elsewhere), and after a
// reprint it's the only way to spend the check on purpose. Quiet, beside the terminal link: it's a way back to the
// truth, not one of the three answers to the question.
const canRerun = computed(() => pushFlow.question.value?.kind === `checks` && pushFlow.command.value !== ``);

/* ONE SLOT FOR THE AGENT, in three shapes, after the pipelines board's own (PipelineRunRow.vue): no attempt,. */
const attempt = computed(() => pushFlow.attempt.value);
const look = computed(() => (attempt.value === undefined ? undefined : fixStanceLook(attempt.value.stance.kind)));
const inPlay = computed(() => attempt.value !== undefined && attempt.value.stance.ongoing);
const runLabel = computed(() => (attempt.value === undefined ? `Fix with agent` : `Continue`));
// The ended attempt's own account of itself, on the primary half; the caret's tooltip says what the run costs.
const runHint = computed(() => attempt.value?.stance.hint);

const startFix = (): void => {
    void pushFlow.startFix(fixModel.overridden.value ? fixModel.model.value : undefined, fixModel.resume.value);
    fixModel.clear();
};

// "Start over" beside a working chip opens the picker rather than acting: the panel names the attempt and its
// button is the press that stops and files it away.
const startOver = ref<ComponentPublicInstance>();
const openStartOver = (): void => {
    const el = startOver.value?.$el as HTMLElement | undefined;
    if (el === undefined) {
        return;
    }
    void fixModel.choose(el, `Start over`).then((committed) => {
        if (committed) {
            startFix();
        }
    });
};
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

<!-- ONE ROW FOR ALL ANSWERS: the way back to the output on the left, the actions on the right. -->
        <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
            <!-- Ways back to the truth, not answers to the question: what actually happened, and measuring it again. -->
            <div class="mr-auto flex items-center gap-3">
                <button
                    v-if="pushFlow.terminal.value !== undefined"
                    type="button"
                    class="flex items-center gap-1.5 rounded text-2xs text-muted transition-colors hover:text-content"
                    @click="pushFlow.showTerminal"
                >
                    <Icon name="terminal" class="text-2xs" />
                    Show terminal
                </button>

                <button
                    v-if="canRerun"
                    type="button"
                    class="flex items-center gap-1.5 rounded text-2xs text-muted transition-colors hover:text-content"
                    v-tooltip.top="`Run the check again on the tree as it is now`"
                    @click="pushFlow.runAgain"
                >
                    <Icon name="refresh" class="text-2xs" />
                    Run again
                </button>
            </div>

<!-- Hand the failure to an agent. -->
            <template v-if="pushFlow.proposedFix.value && attempt && look && inPlay">
<!-- The kit's chip, which is what this is: state, not rank (ui.ts's vocabulary). -->
                <button
                    type="button"
                    class="ui-chip shrink-0 rounded px-2 py-1 text-xs font-medium"
                    :class="[look.ink, look.chip]"
                    v-tooltip.top="attempt.stance.hint"
                    :aria-label="`Fix agent: ${attempt.stance.label.toLowerCase()} — open the conversation`"
                    @click="pushFlow.openAttempt"
                >
                    <Icon :name="look.icon" :spin="look.spin" class="text-2xs" />
                    {{ attempt.stance.label }}
                </button>
                <Button
                    ref="startOver"
                    size="small"
                    severity="secondary"
                    text
                    label="Start over"
                    icon-pos="right"
                    :loading="pushFlow.fixBusy.value"
                    v-tooltip.top="`Set this attempt aside and start a fresh one — opens the picker first`"
                    @click="openStartOver"
                >
                    <template #icon><Icon name="chevron-down" class="text-2xs" /></template>
                </Button>
            </template>
            <AgentRunButton
                v-else-if="pushFlow.proposedFix.value"
                :label="runLabel"
                :picker="fixModel"
                :loading="pushFlow.fixBusy.value"
                :hint="runHint"
                @run="startFix"
            />

<!-- Push anyway, and it never asks twice. -->
            <Button size="small" severity="warn" :label="pushAnywayLabel" @click="pushFlow.pushAnyway" />
        </div>
        <!-- Why the last press started nothing, in the daemon's words; the question stays up above it. -->
        <p v-if="pushFlow.fixError.value" class="mt-1.5 break-words text-2xs text-danger">{{ pushFlow.fixError.value }}</p>
    </div>
</template>

<style scoped>
.checks-command :deep(.shiki),
.checks-command :deep(pre) {
    border: 0;
    background-color: transparent !important;
}
</style>
