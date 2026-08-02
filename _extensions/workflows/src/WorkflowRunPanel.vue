<script setup lang="ts">
import { Button, cmp, Dialog, Icon, timeAgo } from "@intentic/extension-ui";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import WorkflowGraph from "./WorkflowGraph.vue";
import { host } from "./host";
import { STEP_TONE } from "./workflowDag";
import { useWorkflows } from "./useWorkflows";

/* WATCHING A RUN. The graph, and under it whichever step you clicked.
 *
 * A run is the longest-lived thing in the product — hours, sometimes — so the question this answers is not
 * "what happened" but "where is it, and is it going anywhere". Hence what the node cards carry: state, and the
 * ITERATION COUNT, which is the only number that separates a step that is working from a step that is stuck.
 *
 * THE STEP PANEL LEADS WITH THE OUTPUT, not with the status. By the time you have clicked a node you already
 * know its colour; what you came for is what it decided — and for a `json` step that is a table, which is the
 * whole reason declared outputs exist. The link to the transcript is last because it is the escape hatch: if
 * the output answers the question you never needed the transcript, and if it does not, nothing here will.
 */

const { run } = defineProps<{ run: WorkflowRun }>();
const open = defineModel<boolean>({ required: true });

const { stop } = useWorkflows();
const selectedId = ref<string | undefined>();
const failure = ref<string>();

// Follow the run: with nothing picked, show whatever is moving. A run left open on a stale selection is a
// panel describing a step that finished twenty minutes ago while three others came and went.
const shown = computed(() => {
    const picked = run.steps.find((step) => step.stepId === selectedId.value);
    return picked ?? run.steps.find((step) => step.state === `running`) ?? run.steps.find((step) => step.state === `failed`) ?? run.steps[0];
});
const shownStep = computed(() => run.workflow.steps.find((step) => step.id === shown.value?.stepId));

watch(
    () => run.runId,
    () => {
        selectedId.value = undefined;
        failure.value = undefined;
    },
);

const spent = computed(() => run.steps.reduce((total, step) => total + (step.costUsd ?? 0), 0));
const finished = computed(() => run.steps.filter((step) => step.state === `done`).length);

// The document's `data`, as rows. A record rather than a list in the contract because that is what the model
// writes; flattened here because a table is what a person reads.
const dataRows = computed(() => Object.entries(shown.value?.document?.data ?? {}).map(([key, value]) => ({ key, value })));

const asText = (value: unknown): string =>
    Array.isArray(value) ? value.map(String).join(`\n`) : typeof value === `object` ? JSON.stringify(value, undefined, 2) : String(value);

const stopRun = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await stop.mutateAsync(run.runId);
    } catch (error) {
        failure.value = error instanceof Error ? error.message : `The run could not be stopped.`;
    }
};

// A step's conversation is an ordinary fleet agent, so the chat it is having is reachable exactly as any other
// agent's is. This is the door from a node on a graph to the actual work.
const openChat = (conversationId: string): void => host().navigate(`/agents/${encodeURIComponent(conversationId)}`);
</script>

<template>
    <Dialog v-model:visible="open" :modal="true" :draggable="false" :style="{ width: '68rem', maxWidth: '95vw' }" :header="run.workflow.name">
        <div class="flex flex-col gap-3">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                <span class="font-medium" :class="run.state === `done` ? `text-success` : run.state === `running` ? `text-link` : `text-content`">
                    {{ run.state }}
                </span>
                <span>{{ finished }} of {{ run.steps.length }} steps done</span>
                <span v-if="spent > 0">${{ spent.toFixed(2) }}</span>
                <span>started {{ timeAgo(run.startedAt) }}</span>
                <span class="flex-1"></span>
                <Button
                    v-if="run.state === `running`"
                    label="Stop"
                    size="small"
                    severity="secondary"
                    :disabled="stop.isPending.value"
                    @click="stopRun()"
                >
                    <template #icon><Icon name="stop" /></template>
                </Button>
            </div>
            <p v-if="run.detail" class="text-xs text-subtle">{{ run.detail }}</p>

            <WorkflowGraph v-model="selectedId" :workflow="run.workflow" :run="run" />

            <div v-if="shown && shownStep" class="flex flex-col gap-2 rounded-lg border border-line bg-card p-3">
                <div class="flex flex-wrap items-center gap-2">
                    <Icon
                        :name="STEP_TONE[shown.state].icon"
                        :class="[STEP_TONE[shown.state].text, STEP_TONE[shown.state].spin ? `animate-spin` : ``]"
                    />
                    <span class="text-sm font-medium text-content">{{ shownStep.title }}</span>
                    <span class="text-2xs" :class="STEP_TONE[shown.state].text">{{ STEP_TONE[shown.state].label }}</span>
                    <span v-if="shown.iterations > 0" class="text-2xs text-subtle">
                        {{ shown.iterations }} iteration{{ shown.iterations === 1 ? `` : `s` }}
                    </span>
                    <span v-if="shown.costUsd" class="text-2xs text-subtle">${{ shown.costUsd.toFixed(2) }}</span>
                    <span class="flex-1"></span>
                    <Button label="Open the chat" size="small" severity="secondary" :text="true" @click="openChat(shown.conversationId)">
                        <template #icon><Icon name="arrow-right" /></template>
                    </Button>
                </div>

                <p class="text-xs text-subtle"><span class="text-content">Done means:</span> {{ shownStep.goal }}</p>

                <!-- The declared output, as a table. The reason `json` exists: a step's conclusion as data you
                     can read at a glance and the next step can act on, rather than as a paragraph about it. -->
                <div v-if="dataRows.length > 0" class="overflow-hidden rounded-md border border-line">
                    <div v-for="row in dataRows" :key="row.key" class="flex gap-3 border-b border-line px-2.5 py-1.5 last:border-b-0">
                        <span class="w-32 shrink-0 font-mono text-2xs text-subtle">{{ row.key }}</span>
                        <span class="min-w-0 flex-1 whitespace-pre-wrap text-xs text-content">{{ asText(row.value) }}</span>
                    </div>
                </div>

                <p v-if="shown.document?.reason" class="text-xs text-content">{{ shown.document.reason }}</p>
                <p v-if="shown.document?.evidence" class="text-2xs text-subtle">{{ shown.document.evidence }}</p>
                <!-- The step's own last words, shown only when there is no document to show instead — otherwise
                     the panel says the same thing twice in two registers. -->
                <p v-else-if="shown.report && shown.document === undefined" class="whitespace-pre-wrap text-xs text-subtle">{{ shown.report }}</p>

                <!-- Why it stopped, which for `failed` is the single most important line on this screen: it says
                     whether to give it more room, change the prompt, or fix the check. -->
                <p v-if="shown.detail" class="text-2xs" :class="shown.state === `failed` ? `text-danger` : `text-subtle`">{{ shown.detail }}</p>
            </div>

            <p v-if="failure" :class="cmp.alertDanger()">{{ failure }}</p>
        </div>
    </Dialog>
</template>
