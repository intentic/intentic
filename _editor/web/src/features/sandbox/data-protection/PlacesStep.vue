<script setup lang="ts">
import type { DataFlow, DataFlowGroup } from "@intentic/sandbox-contract";
import { type IconName, InfoHint, Notice, Row, RowGroup, SkeletonRows, type Tone, toneDot, toneInk } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import HintedTitle from "./HintedTitle.vue";
import { flowFacts, flowTitle, keyOf, questionText, sortFlows } from "./dataProtection";
import { useComplianceReport } from "./useCompliance";

// Step 2: every place this sandbox sends data to, as it is set up now, which the officer lists as recipients. What
// only the office can find out comes first, since it is the step's one errand; then the places in use, one row each
// with its three facts on one line, and last what a single switch would open. The places were seven cards of their own
// until 2026-10-13, each row wearing the same three pills, so nothing stood out. A row is its name and its facts; which
// data it receives and the hosts it reaches are behind the (i) beside the name, for the officer filling in the record.

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
        <SkeletonRows v-if="isLoading" :rows="6" description />
        <template v-else>
            <Notice v-if="questions.length > 0" tone="warning">
                <p class="font-medium">{{ t(`sandbox.dataProtection.questionsTitle`, { count: questions.length }, questions.length) }}</p>
                <ul class="mt-1.5 flex flex-col gap-1">
                    <li v-for="flow in questions" :key="flow.id">
                        <span class="font-medium">{{ flowTitle(flow) }}:</span> {{ questionText(flow.question) }}
                    </li>
                </ul>
            </Notice>

            <RowGroup v-if="list.inUse.length > 0" :label="t(`sandbox.dataProtection.inUse`)">
                <template #info>
                    <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.dataProtection.step.places`) })">
                        <span class="block text-xs text-content">{{ t(`sandbox.dataProtection.placesHint`) }}</span>
                    </InfoHint>
                </template>
                <Row v-for="flow in list.inUse" :key="flow.id" :icon="GROUP_ICON[flow.group]">
                    <template #title>
                        <HintedTitle :title="flowTitle(flow)">
                            {{ dataOf(flow) }}
                            <span v-if="flow.hosts.length > 0" class="mt-2 block font-mono text-2xs text-muted [overflow-wrap:anywhere]">{{
                                flow.hosts.join(` · `)
                            }}</span>
                        </HintedTitle>
                    </template>
                    <template #description>
                        <span class="flex flex-wrap gap-x-3 gap-y-0.5">
                            <span v-for="fact in flowFacts(flow)" :key="fact.text" class="flex items-center gap-1.5">
                                <span :class="toneDot(fact.tone, `size-1.5 shrink-0 rounded-full`)" aria-hidden="true"></span>
                                <span :class="inkOf(fact.tone)">{{ fact.text }}</span>
                            </span>
                        </span>
                    </template>
                </Row>
            </RowGroup>

            <RowGroup v-if="list.idle.length > 0" :label="t(`sandbox.dataProtection.notInUse`)">
                <template #info>
                    <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.dataProtection.notInUse`) })">
                        <span class="block text-xs text-content">{{ t(`sandbox.dataProtection.idleHint`) }}</span>
                    </InfoHint>
                </template>
                <Row v-for="flow in list.idle" :key="flow.id" :icon="GROUP_ICON[flow.group]" class="opacity-70">
                    <template #title>
                        <HintedTitle :title="flowTitle(flow)">{{ dataOf(flow) }}</HintedTitle>
                    </template>
                </Row>
            </RowGroup>
        </template>
    </div>
</template>
