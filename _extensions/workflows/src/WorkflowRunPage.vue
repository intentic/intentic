<script setup lang="ts">
import { appLink, Button, ui, DagGraph, Icon, Notice, noticeOf, timeAgo } from "@intentic/extension-ui";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import WorkflowNodeCard from "./WorkflowNodeCard.vue";
import { host } from "./host";
import { STEP_TONE, workflowDag } from "./workflowDag";
import { useWorkflows } from "./useWorkflows";

// Read-only counterpart to the designer, sharing `workflowDag`/`WorkflowNodeCard` so a run looks like its design. Uses
// `DagGraph`, not `DagEditor`: nothing here is editable. Cards show state and round count, the only signal that
// separates working from stuck; the step panel leads with output, not status.

const { run } = defineProps<{ run: WorkflowRun }>();
const emit = defineEmits<{ close: [] }>();

const { stop } = useWorkflows();
const selectedId = ref<string | undefined>();
const failure = ref<string>();

const dag = computed(() => workflowDag(run.workflow, run));

// With nothing picked, follows whatever is running rather than showing a stale selection.
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

// Flattens the document's `data` record into rows for display.
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

// A step's conversation is an ordinary fleet agent's chat; a real link (`appLink`) so Ctrl/Cmd-click opens it beside
// the diagram.
const chatLink = (conversationId: string) => {
    const path = `/agents/${encodeURIComponent(conversationId)}`;
    return appLink(host().href(path), () => host().navigate(path));
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-line-subtle px-4 py-2.5">
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
                <!-- Never magnified, or a short run would fill the page as billboards, same as the designer's canvas. -->
                <DagGraph v-model="selectedId" :nodes="dag.nodes" :edges="dag.edges" :node-width="216" :node-height="62" :magnify="false">
                    <template #node="{ node }"><WorkflowNodeCard :node="node.data" /></template>
                </DagGraph>
            </div>

            <aside v-if="shown && shownStep" class="flex w-96 shrink-0 flex-col gap-2 overflow-y-auto border-l border-line p-3">
                <div class="flex flex-wrap items-center gap-2">
                    <Icon :name="STEP_TONE[shown.state].icon" :spin="STEP_TONE[shown.state].spin" :class="STEP_TONE[shown.state].text" />
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

                <!-- Falls back to the run's own request, not the step's title, which is a label rather than a completion bar. -->
                <p class="text-xs text-subtle"><span class="text-content">Done when:</span> {{ shownStep.goal ?? run.request }}</p>

                <!-- Declared `json` output as a table: data to read at a glance and for the next step to act on. -->
                <div v-if="dataRows.length > 0" class="overflow-hidden rounded-md border border-line-subtle">
                    <div v-for="row in dataRows" :key="row.key" class="flex gap-3 border-b border-line-subtle px-2.5 py-1.5 last:border-b-0">
                        <span class="w-28 shrink-0 font-mono text-2xs text-subtle">{{ row.key }}</span>
                        <span class="min-w-0 flex-1 whitespace-pre-wrap text-xs text-content">{{ asText(row.value) }}</span>
                    </div>
                </div>

                <p v-if="shown.document?.reason" class="text-xs text-content">{{ shown.document.reason }}</p>
                <p v-if="shown.document?.evidence" class="text-2xs text-subtle">{{ shown.document.evidence }}</p>
                <!-- Shown only when there's no document, to avoid saying the same thing twice. -->
                <p v-else-if="shown.report && shown.document === undefined" class="whitespace-pre-wrap text-xs text-subtle">{{ shown.report }}</p>

                <!-- Why it stopped; for a failed step this says whether to retry, reprompt, or fix the check. -->
                <p v-if="shown.detail" class="text-2xs" :class="shown.state === `failed` ? `text-danger` : `text-subtle`">{{ shown.detail }}</p>
            </aside>
        </div>
    </div>
</template>
