<script setup lang="ts">
import type { DataFlow, DataFlowGroup } from "@intentic/sandbox-contract";
import { type IconName, Notice, Row, RowGroup, SkeletonRows, type Tone, toneDot, toneInk } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { flowFacts, flowTitle, keyOf, questionText, sortFlows } from "./dataProtection";
import { useComplianceReport } from "./useCompliance";

// Step 2: every place this sandbox sends data to, as it is set up now, which the officer lists as recipients. What
// only the office can find out comes first, since it is the step's one errand; then the places in use, one row each
// with its three facts on one line, and last what a single switch would open. The places were seven cards of their own
// until 2026-10-13, each row wearing the same three pills, so nothing stood out.

const t = useT();
const { report, isLoading } = useComplianceReport();
const list = computed(() => sortFlows(report.value?.flows ?? []));
const questions = computed(() => list.value.inUse.filter((flow): flow is DataFlow & { question: string } => flow.question !== undefined));

// A glyph per kind of place, so a long list is scanned by shape before it is read.
const GROUP_ICON = {
    models: `sparkles`,
    messaging: `comments`,
    connectors: `link`,
    speech: `volume-up`,
    web: `globe`,
    platform: `cloud`,
    maintenance: `refresh`,
    analytics: `eye`,
} as const satisfies Record<DataFlowGroup, IconName>;

// A neutral fact is plain reading text rather than the tone's faint ink: it is most of what the line says.
const inkOf = (tone: Tone): string => (tone === `neutral` ? `text-muted` : toneInk(tone));

const dataOf = (flow: DataFlow): string => t(`sandbox.dataProtection.data.${keyOf(flow.kind)}`);
</script>

<template>
    <div class="flex flex-col gap-6">
        <p class="text-xs text-muted">{{ t(`sandbox.dataProtection.placesIntro`) }}</p>

        <SkeletonRows v-if="isLoading" :rows="6" description />
        <template v-else>
            <Notice v-if="questions.length > 0" tone="warning">
                <p class="font-medium">{{ t(`sandbox.dataProtection.questionsTitle`, { count: questions.length }, questions.length) }}</p>
                <ul class="mt-2 flex flex-col gap-2">
                    <li v-for="flow in questions" :key="flow.id">
                        <span class="block font-medium">{{ flowTitle(flow) }}</span>
                        <span class="block">{{ t(`sandbox.dataProtection.officeAnswers`) }} {{ questionText(flow.question) }}</span>
                    </li>
                </ul>
            </Notice>

            <RowGroup v-if="list.inUse.length > 0" :label="t(`sandbox.dataProtection.inUse`)" :count="list.inUse.length">
                <Row v-for="flow in list.inUse" :key="flow.id" :icon="GROUP_ICON[flow.group]" :title="flowTitle(flow)" :description="dataOf(flow)" indent>
                    <template #below>
                        <div class="flex flex-col gap-1">
                            <p class="flex flex-wrap gap-x-4 gap-y-1 text-2xs">
                                <span v-for="fact in flowFacts(flow)" :key="fact.text" class="flex items-center gap-1.5">
                                    <span :class="toneDot(fact.tone, `size-1.5 shrink-0 rounded-full`)" aria-hidden="true"></span>
                                    <span :class="inkOf(fact.tone)">{{ fact.text }}</span>
                                </span>
                            </p>
                            <p v-if="flow.hosts.length > 0" class="font-mono text-2xs text-subtle [overflow-wrap:anywhere]">{{ flow.hosts.join(` · `) }}</p>
                        </div>
                    </template>
                </Row>
            </RowGroup>

            <RowGroup
                v-if="list.idle.length > 0"
                :label="t(`sandbox.dataProtection.notInUse`)"
                :caption="t(`sandbox.dataProtection.idleCaption`)"
                :count="list.idle.length"
            >
                <Row v-for="flow in list.idle" :key="flow.id" :icon="GROUP_ICON[flow.group]" :title="flowTitle(flow)" :description="dataOf(flow)" class="opacity-70" />
            </RowGroup>
        </template>
    </div>
</template>
