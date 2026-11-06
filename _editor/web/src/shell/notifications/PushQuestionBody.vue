<script setup lang="ts">
import { Button, Code, CopyButton, Icon, timeAgo } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { usePushFlow } from "../../models/changes/usePushFlow";
import { here, page } from "../../lib/routes/links";
import FixWithAgent from "../../parts/fleet/FixWithAgent.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* WHAT THE PUSH QUESTION CARRIES THAT TWO STRINGS CANNOT: the command in monospace, and the way back to the terminal it all came out of. */

const pushFlow = usePushFlow();
const router = useRouter();

/* A PUSH REFUSED FOR WANT OF A SIGN-IN LEADS TO THE ACCOUNT THAT FIXES IT: the terminal and a retry would only say it again. */
const connectLabel = computed<string | undefined>(() =>
    pushFlow.connectHost.value === `github`
        ? t(`shell.pushQuestionBody.connectGithub`)
        : pushFlow.connectHost.value === `gitlab`
          ? t(`shell.pushQuestionBody.connectGitlab`)
          : undefined,
);
const connectHint = computed<string | undefined>(() =>
    pushFlow.connectHost.value === `github`
        ? t(`shell.pushQuestionBody.signInRefusedGithub`)
        : pushFlow.connectHost.value === `gitlab`
          ? t(`shell.pushQuestionBody.signInRefusedGitlab`)
          : undefined,
);
const connect = (): void => {
    const host = pushFlow.connectHost.value;
    if (host !== undefined) {
        void router.push(here(page.capabilities(host)));
    }
};

/* A REFUSAL ONLY JUDGMENT SETTLES OFFERS AN AGENT (agentFix.ts): a conflict, a hook's findings, a branch that only takes pull
   requests. It leads the row unless a deterministic answer is on offer (an account to connect, a pull that clears it). */
const fixLeads = computed(() => pushFlow.fix.value !== undefined && connectLabel.value === undefined && !pushFlow.canSyncAndRetry.value);
const retryQuiet = computed(() => connectLabel.value !== undefined || pushFlow.canSyncAndRetry.value || fixLeads.value);

/* A CARD THAT IS NOT NEWS SAYS SO: raised once when the push is refused, and again on every reopen. */
const clock = useNow(() => pushFlow.fromMemory.value);
const memoryLine = computed<string | undefined>(() => {
    const at = pushFlow.verdictAt.value;
    if (!pushFlow.fromMemory.value || at === undefined) {
        return undefined;
    }
    const when = t(`shell.pushQuestionBody.fromWhen`, { when: timeAgo(at, { now: clock.value }) });
    return pushFlow.heldStale.value ? t(`shell.pushQuestionBody.staleSince`, { when }) : t(`shell.pushQuestionBody.unchangedSince`, { when });
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
            <p v-if="connectHint" class="break-words text-2xs text-content">{{ connectHint }}</p>
            <p v-if="pushFlow.canSyncAndRetry.value" class="break-words text-2xs text-content">{{ t(`shell.pushQuestionBody.syncHint`) }}</p>
            <!-- Only on a reprint: a card reporting a run that just ended dates itself by being here. -->
            <p v-if="memoryLine" class="break-words text-2xs text-subtle">{{ memoryLine }}</p>
        </div>

        <!-- ONE ROW: the way back to the output on the left, the answer on the right. -->
        <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
            <!-- The way back to what actually happened, not an answer to the question. -->
            <div class="mr-auto flex items-center gap-3">
                <CopyButton :text="pushFlow.failureDetails.value" :label="t(`shell.pushQuestionBody.copyDetails`)" />
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

            <!-- The account whose sign-in refused the push, when connecting it is the fix. -->
            <Button tier="accent" v-if="connectLabel" size="small" :label="connectLabel" @click="connect" />
            <Button
                v-if="pushFlow.canSyncAndRetry.value"
                size="small"
                :tier="connectLabel ? `boring` : `accent`"
                :label="t(`shell.pushQuestionBody.syncAndRetry`)"
                @click="pushFlow.syncAndRetry"
            />
            <!-- The agent that settles what a retry would only hear again; once it has it, the card is its. -->
            <FixWithAgent v-if="pushFlow.fix.value" :fix="pushFlow.fix.value" :tier="fixLeads ? `accent` : `boring`" @started="pushFlow.dismiss" />
            <!-- The same push again, hook and all. -->
            <Button
                size="small"
                :tier="retryQuiet ? `boring` : `accent`"
                :tone="retryQuiet ? undefined : `warning`"
                :label="t(`ui.action.tryAgain`)"
                @click="pushFlow.retry"
            />
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
