<script setup lang="ts">
import { appLink, Button, ui, DagGraph, Icon, Notice, noticeOf, timeAgo } from "@intentic/extension-ui";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import WorkflowNodeCard from "./WorkflowNodeCard.vue";
import { host } from "./host";
import { STEP_TONE, workflowDag } from "./workflowDag";
import { useWorkflows } from "./useWorkflows";

/* WATCHING A RUN: the same page shape as the designer, and read-only.
 *
 * IT USES DagGraph, NOT DagEditor, and that is the point of there being two: nothing here is editable, so
 * nothing here offers a handle to drag or an edge to click. The graph is the same picture either way because
 * both read `workflowDag` and both draw `WorkflowNodeCard`: a run and the design it came from must not look
 * like two different workflows.
 *
 * A run is the longest-lived thing in the product, so the question this answers is not "what happened" but
 * "where is it, and is it going anywhere". Hence what the cards carry: state, and the ROUND COUNT, which is
 * the only number that separates a step that is working from one that is stuck.
 *
 * THE STEP PANEL LEADS WITH THE OUTPUT, not the status: by the time you have clicked a node you know its
 * colour, and what you came for is what it decided. The transcript link is last because it is the escape
 * hatch: if the output answered the question you never needed it.
 */

const { run } = defineProps<{ run: WorkflowRun }>();
const emit = defineEmits<{ close: [] }>();

const { stop } = useWorkflows();
const selectedId = ref<string | undefined>();
const failure = ref<string>();

const dag = computed(() => workflowDag(run.workflow, run));

// Follow the run: with nothing picked, show whatever is moving. A panel left on a stale selection describes a
// step that finished twenty minutes ago while three others came and went.
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

// The document's `data`, as rows. A record in the contract because that is what the model writes; flattened
// here because a table is what a person reads.
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

/* A step's conversation is an ordinary fleet agent, so its chat is reachable exactly as any other agent's is.
 * This is the door from a block on the diagram to the session log behind it, and it is a real link (appLink),
 * so the address is under the pointer and Ctrl/⌘-click opens the log beside the diagram it came from. */
const chatLink = (conversationId: string) => {
    const path = `/agents/${encodeURIComponent(conversationId)}`;
    return appLink(host().href(path), () => host().navigate(path));
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <button type="button" :class="ui.iconButton()" aria-label="Back to workflows" @click="emit(`close`)"><Icon name="arrow-left" /></button>
            <span class="text-sm font-medium text-content">{{ run.workflow.name }}</span>
            <span class="text-2xs font-medium" :class="run.state === `done` ? `text-success` : run.state === `running` ? `text-link` : `text-subtle`">
                {{ run.state }}
            </span>
            <span class="text-2xs text-subtle">{{ finished }} of {{ run.steps.length }} steps</span>
            <span v-if="spent > 0" class="text-2xs text-subtle">${{ spent.toFixed(2) }}</span>
            <span class="text-2xs text-subtle">started {{ timeAgo(run.startedAt) }}</span>
            <span class="flex-1"></span>
            <Button v-if="run.state === `running`" label="Stop" size="small" severity="secondary" :disabled="stop.isPending.value" @click="stopRun()">
                <template #icon><Icon name="stop" /></template>
            </Button>
        </header>

        <Notice v-if="failure" :of="noticeOf(failure)" class="m-3" />
        <p v-if="run.detail" class="shrink-0 px-4 py-2 text-xs text-subtle">{{ run.detail }}</p>

        <div class="flex min-h-0 flex-1">
            <div class="min-w-0 flex-1">
                <!-- Never magnified: this graph gets a whole page, where filling it in both directions turns a
                     short run into billboards. Same answer the designer's canvas gives (DagEditor's own cap). -->
                <DagGraph v-model="selectedId" :nodes="dag.nodes" :edges="dag.edges" :node-width="216" :node-height="62" :magnify="false">
                    <template #node="{ node }"><WorkflowNodeCard :node="node.data" /></template>
                </DagGraph>
            </div>

            <aside v-if="shown && shownStep" class="flex w-96 shrink-0 flex-col gap-2 overflow-y-auto border-l border-line p-3">
                <div class="flex flex-wrap items-center gap-2">
                    <Icon
                        :name="STEP_TONE[shown.state].icon"
                        :class="[STEP_TONE[shown.state].text, STEP_TONE[shown.state].spin ? `animate-spin` : ``]"
                    />
                    <span class="text-sm font-medium text-content">{{ shownStep.title }}</span>
                    <span class="text-2xs" :class="STEP_TONE[shown.state].text">{{ STEP_TONE[shown.state].label }}</span>
                    <span v-if="shown.iterations > 0" class="text-2xs text-subtle"
                        >{{ shown.iterations }} round{{ shown.iterations === 1 ? `` : `s` }}</span
                    >
                    <span v-if="shown.costUsd" class="text-2xs text-subtle">${{ shown.costUsd.toFixed(2) }}</span>
                </div>

                <Button label="Open the session log" size="small" severity="secondary" :text="true" as="a" v-bind="chatLink(shown.conversationId)">
                    <template #icon><Icon name="arrow-right" /></template>
                </Button>

                <!-- A step with no goal of its own is measured against what the run was asked to do, so THAT is
                     what "done when" has to show. Falling back to the run's request rather than to the step's
                     title: the title is a label ("Claude's attempt"), and reading it here as a completion bar
                     is how a panel starts describing a rule the scheduler is not applying. -->
                <p class="text-xs text-subtle"><span class="text-content">Done when:</span> {{ shownStep.goal ?? run.request }}</p>

                <!-- The declared output, as a table. The reason `json` exists: a step's conclusion as data you
                     can read at a glance and the next step can act on, rather than a paragraph about it. -->
                <div v-if="dataRows.length > 0" class="overflow-hidden rounded-md border border-line">
                    <div v-for="row in dataRows" :key="row.key" class="flex gap-3 border-b border-line px-2.5 py-1.5 last:border-b-0">
                        <span class="w-28 shrink-0 font-mono text-2xs text-subtle">{{ row.key }}</span>
                        <span class="min-w-0 flex-1 whitespace-pre-wrap text-xs text-content">{{ asText(row.value) }}</span>
                    </div>
                </div>

                <p v-if="shown.document?.reason" class="text-xs text-content">{{ shown.document.reason }}</p>
                <p v-if="shown.document?.evidence" class="text-2xs text-subtle">{{ shown.document.evidence }}</p>
                <!-- The step's own last words, only when there is no document to show instead: otherwise the
                     panel says the same thing twice in two registers. -->
                <p v-else-if="shown.report && shown.document === undefined" class="whitespace-pre-wrap text-xs text-subtle">{{ shown.report }}</p>

                <!-- Why it stopped, which for a failed step is the most important line here: it says whether to
                     give it more room, change the prompt, or fix the check. -->
                <p v-if="shown.detail" class="text-2xs" :class="shown.state === `failed` ? `text-danger` : `text-subtle`">{{ shown.detail }}</p>
            </aside>
        </div>
    </div>
</template>
