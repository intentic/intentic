<script setup lang="ts">
import { ui } from "@intentic/ui";
import Button from "primevue/button";
import SuggestedSessionBox from "../agents/SuggestedSessionBox.vue";
import { usePushFlow } from "../composables/workspace/usePushFlow";

/* THE ONE THING A PUSH INTERRUPTS YOU FOR: a check that said no, or a push the remote refused.
 *
 * WHY IT IS MOUNTED ABOVE THE ROUTER. The question is raised minutes after the click that caused it, and by
 * then the user is somewhere else, that is not a failure mode, it is the design: the check runs in a terminal
 * and the app tells them to get on with something. A notice that lived in the Changes panel could only be seen
 * by someone who had stayed put, which is precisely the person who least needs telling. So it rides with the
 * session (shell/WorkspaceRuntime.vue) and is on screen wherever they happen to be standing.
 *
 * RED ONLY. A pass sends the push and says so in the panel, quietly, where the click was: being interrupted to
 * be told that nothing is wrong is how a notice teaches people to dismiss it unread. What is here is a decision
 * the user still owes: push it anyway, hand it to an agent, or let it go.
 *
 * NOT A DIALOG, and no mask. It sits at the top of the viewport over whatever the user is doing, and everything
 * underneath keeps working: including the terminal the suite ran in, which a modal would dim and freeze at the
 * exact moment its output became the interesting thing on screen. It holds no output for the same reason: the
 * whole of it is one click away in the terminal, in colour (composables/terminal/useTerminalPanel.ts).
 *
 * It waits. Nothing dismisses it but the user: a question that timed out would be a decision nobody made. */

const pushFlow = usePushFlow();
</script>

<template>
    <div
        v-if="pushFlow.question.value"
        class="fixed inset-x-3 top-3 z-40 mx-auto w-auto max-w-[34rem] rounded-lg border border-line-strong bg-card p-3 shadow-lg md:inset-x-0"
        role="alertdialog"
        :aria-label="pushFlow.question.value.title"
    >
        <div class="flex items-start gap-2">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-xs text-danger" />
            <div class="min-w-0 flex-1">
                <p class="text-xs font-medium text-content">{{ pushFlow.question.value.title }}</p>
                <!-- The command leads the line in monospace, exactly as it did while the check was still going,
                     so what changed when the run settled is the tense and nothing else. -->
                <p class="mt-0.5 break-words text-2xs text-muted">
                    <span v-if="pushFlow.question.value.command" class="font-mono text-content">{{ pushFlow.question.value.command }}</span>
                    {{ pushFlow.question.value.detail }}
                </p>
            </div>
            <button
                type="button"
                class="shrink-0 rounded p-0.5 text-muted transition-colors hover:text-content"
                @click="pushFlow.dismiss"
                v-tooltip.left="'Leave it'"
                aria-label="Dismiss"
            >
                <Icon name="times" class="text-2xs" />
            </button>
        </div>

        <!-- The proposal: the whole turn composed from the failure, text, model, effort, and editable to the
             last character before it costs anything (composables/agents/sessionSuggestion.ts). Absent for a
             check that could not run and for one the user stopped: nothing was learned about the code either
             way, so an agent sent after it would be hunting a bug that isn't there. -->
        <template v-if="pushFlow.proposedFix.value">
            <p class="mb-1.5 mt-3 text-2xs font-medium uppercase tracking-wide text-subtle">Fix it with an agent</p>
            <SuggestedSessionBox :conversation="pushFlow.proposedFix.value" action="Start agent" @start="pushFlow.startFix" />
        </template>

        <div class="mt-3 flex items-center justify-end gap-1">
            <!-- Only where there is a terminal to go to: without the tmux wrapper the suite ran in an invisible
                 shell, and a button that opens an empty panel is worse than none. -->
            <button
                v-if="pushFlow.terminal.value !== undefined"
                type="button"
                class="mr-auto flex items-center gap-1.5 rounded px-2 py-1 text-2xs text-muted transition-colors hover:text-content"
                @click="pushFlow.showTerminal"
            >
                <Icon name="terminal" class="text-2xs" />
                Show terminal
            </button>
            <!-- Push anyway, and it never asks twice. The user knows things the check does not: that this IS the
                 fix for the failure, that the suite is flaky, that they want it on a branch to look at in CI.
                 After a failed PUSH there is nothing to override: the send itself is what refused, so the same
                 button becomes the retry, which is the only useful thing left to offer. -->
            <Button
                size="small"
                severity="warn"
                @click="pushFlow.pushAnyway"
                :label="pushFlow.question.value.kind === `push` ? `Try again` : `${pushFlow.pending.value?.verb ?? `Push`} anyway`"
            />
        </div>
    </div>
</template>
