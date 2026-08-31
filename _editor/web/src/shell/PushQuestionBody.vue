<script setup lang="ts">
import { Button, Code, Icon } from "@intentic/ui";
import { computed } from "vue";
import SuggestedSessionBox from "../agents/SuggestedSessionBox.vue";
import { usePushFlow } from "../composables/workspace/usePushFlow";

/* WHAT THE PUSH QUESTION CARRIES THAT TWO STRINGS CANNOT: the command in monospace, the whole proposed agent
 * turn, and the way back to the terminal it all came out of.
 *
 * The question itself — its sentence, its tone, its dismiss — is a notification like any other
 * (composables/notificationSources.ts). This is only the part of it that has to be markup, mounted by the lane
 * as the card's body. Splitting it that way is what lets the most complicated thing this app floats use the
 * same box as "3 files deleted". The two ANSWERS are here rather than in the lane's action row, so that they
 * sit on one row together; see the row itself. */

const pushFlow = usePushFlow();

const pushAnywayLabel = computed(() => (pushFlow.question.value?.kind === `push` ? `Try again` : `${pushFlow.pending.value?.verb ?? `Push`} anyway`));
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

        <!-- ONE ROW FOR BOTH ANSWERS: the way back to the output on the left, the override on the right.
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

            <!-- Push anyway, and it never asks twice. The user knows things the check does not: that this IS the
                 fix for the failure, that the suite is flaky, that they want it on a branch to look at in CI.
                 After a failed PUSH there is nothing to override — the send itself is what refused — so the same
                 button becomes the retry, which is the only useful thing left. -->
            <Button size="small" severity="warn" :label="pushAnywayLabel" @click="pushFlow.pushAnyway" />
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
