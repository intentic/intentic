<script setup lang="ts">
import { Code, Icon } from "@intentic/ui";
import SuggestedSessionBox from "../agents/SuggestedSessionBox.vue";
import { usePushFlow } from "../composables/workspace/usePushFlow";

/* WHAT THE PUSH QUESTION CARRIES THAT TWO STRINGS CANNOT: the command in monospace, the whole proposed agent
 * turn, and the way back to the terminal it all came out of.
 *
 * The question itself — its sentence, its Push-anyway button, its dismiss — is a notification like any other
 * (composables/notificationSources.ts). This is only the part of it that has to be markup, mounted by the lane
 * as the card's body. Splitting it that way is what lets the most complicated thing this app floats use the
 * same box as "3 files deleted". */

const pushFlow = usePushFlow();
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

        <!-- The proposal: the whole turn composed from the failure — text, model, effort — and editable to the
             last character before it costs anything (composables/agents/sessionSuggestion.ts). Absent for a check
             that could not run and for one the user stopped: nothing was learned about the code either way, so an
             agent sent after it would be hunting a bug that isn't there. -->
        <template v-if="pushFlow.proposedFix.value">
            <p class="mb-1.5 mt-3 text-2xs font-medium uppercase tracking-wide text-subtle">Fix it with an agent</p>
            <SuggestedSessionBox :conversation="pushFlow.proposedFix.value" action="Start agent" @start="pushFlow.startFix" />
        </template>

        <!-- Only where there is a terminal to go to: without the tmux wrapper the suite ran in an invisible
             shell, and a button that opens an empty panel is worse than none. It holds no output itself for the
             same reason — the whole of it is one press away, in colour. -->
        <button
            v-if="pushFlow.terminal.value !== undefined"
            type="button"
            class="mt-2 flex items-center gap-1.5 rounded text-2xs text-muted transition-colors hover:text-content"
            @click="pushFlow.showTerminal"
        >
            <Icon name="terminal" class="text-2xs" />
            Show terminal
        </button>
    </div>
</template>

<style scoped>
.checks-command :deep(.shiki),
.checks-command :deep(pre) {
    border: 0;
    background-color: transparent !important;
}
</style>
