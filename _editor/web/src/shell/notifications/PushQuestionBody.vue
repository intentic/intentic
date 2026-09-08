<script setup lang="ts">
import { AgentRunButton, Button, Code, fixStanceLook, Icon, useAgentRunPick } from "@intentic/ui";
import { type ComponentPublicInstance, computed, ref } from "vue";
import { shellModelPicking } from "../../features/chat/models/shellModelPicking";
import { usePushFlow } from "../../features/workspace/push/usePushFlow";

/* WHAT THE PUSH QUESTION CARRIES THAT TWO STRINGS CANNOT: the command in monospace,
 * and the way back to the terminal it all came out of.
 *
 * The question itself — its sentence, its tone, its dismiss — is a notification like any other
 * (composables/notificationSources.ts). This is only the part of it that has to be markup, mounted by the lane
 * as the card's body. Splitting it that way is what lets the most complicated thing this app floats use the
 * same box as "3 files deleted". The answers are here rather than in the lane's action row, so that they
 * sit on one row together; see the row itself. */

const pushFlow = usePushFlow();
// The attempt already on this failure rides into the picker, so its bar ends in Continue / Start over.
const fixModel = useAgentRunPick(
    () => shellModelPicking(),
    `pre-push-fix`,
    () => pushFlow.attemptOnOffer.value,
);

const pushAnywayLabel = computed(() => (pushFlow.question.value?.kind === `push` ? `Try again` : `${pushFlow.pending.value?.verb ?? `Push`} anyway`));

/* ONE SLOT FOR THE AGENT, in three shapes, after the pipelines board's own (PipelineRunRow.vue): no attempt, or
 * a landed one, is a plain "Fix with agent"; an attempt still in play is a chip that opens it, beside a quiet
 * "Start over" that only opens the picker (no one-click path files a working agent away); an attempt that ENDED
 * is "Continue", whose caret also offers Start over. The words are the contract's `fixStance`, the same the
 * board and the fleet use, so the same agent is never described two ways one click apart. */
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
    <!-- ONE UNCONDITIONAL ROOT ELEMENT, so the lane's own class lands somewhere: a `v-if` here would render a
         comment node for the tick between the question clearing and the card retiring, and an attribute has
         nothing to fall through to on a comment. -->
    <div>
        <!-- The command that failed in a 1-line syntax-highlighted code block. -->
        <div v-if="pushFlow.question.value" class="flex flex-col gap-1.5">
            <div v-if="pushFlow.question.value.command" class="checks-command flex min-w-0 items-center rounded-md border border-line bg-canvas">
                <Code class="min-w-0 flex-1" :code="pushFlow.question.value.command" lang="bash" :copyable="false" />
            </div>
            <p v-if="pushFlow.question.value.detail" class="break-words text-2xs text-muted">
                {{ pushFlow.question.value.detail }}
            </p>
        </div>

        <!-- ONE ROW FOR ALL ANSWERS: the way back to the output on the left, the actions on the right.
             The override is the card's own decision and used to be a notification action, which put it on a row
             of its own under this one — two strips of chrome, 40px of card, to hold one link and one button that
             read as a pair. It lives here instead, so the lane renders no action row for this question at all
             (composables/notificationSources.ts).

             The terminal link appears only where there is a terminal to go to: without the tmux wrapper the
             suite ran in an invisible shell, and a button that opens an empty panel is worse than none. It holds
             no output itself for the same reason — the whole of it is one press away, in colour. `mr-auto`
             rather than `justify-between`, so the button keeps the right edge whether or not the link is
             there. -->
        <div class="mt-2 flex items-center justify-end gap-2">
            <button
                v-if="pushFlow.terminal.value !== undefined"
                type="button"
                class="mr-auto flex items-center gap-1.5 rounded text-2xs text-muted transition-colors hover:text-content"
                @click="pushFlow.showTerminal"
            >
                <Icon name="terminal" class="text-2xs" />
                Show terminal
            </button>

            <!-- Hand the failure to an agent. Absent for a check that could not run and for one the user stopped:
                 nothing was learned about the code either way, so an agent sent after it would be hunting a bug
                 that isn't there. -->
            <template v-if="pushFlow.proposedFix.value && attempt && look && inPlay">
                <button
                    type="button"
                    class="touch-target inline-flex shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-xs font-medium"
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

            <!-- Push anyway, and it never asks twice. The user knows things the check does not: that this IS the
                 fix for the failure, that the suite is flaky, that they want it on a branch to look at in CI.
                 After a failed PUSH there is nothing to override — the send itself is what refused — so the same
                 button becomes the retry, which is the only useful thing left. -->
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
