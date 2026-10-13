<script setup lang="ts">
import type { ComplianceDocumentFormat, ComplianceDocumentKind, DataFlow, Measure, MeasureCategory, PresetItem } from "@intentic/sandbox-contract";
import { Button, ConfirmDialog, Notice, type NoticeModel, Row, RowGroup, RowNote, SegmentedControl, SkeletonRows, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { activeLocale, useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { useRole } from "../../../client/sandbox/useRole";
import {
    documentLanguageFor,
    groupFlows,
    keyOf,
    MEASURE_LINKS,
    PERSONAL_TONE,
    presetLabel,
    presetValue,
    questionText,
    SHIELD_TONE,
    STATUS_TONE,
} from "./dataProtection";
import { downloadDocument, useComplianceReport, usePreset } from "./useCompliance";

// The data protection page (Ochrona danych): what a data protection officer needs before this sandbox handles anyone's
// personal data. The documents first, since they are what the officer came for; then where data can leave and what
// protects it, both read from the live configuration; last the public-office preset, the only thing here that changes
// anything, and only the items ticked, after a confirmation. Maintainer and up see it; only the owner applies.

const t = useT();
const { isOwner } = useRole();
const { report, error: reportError, isLoading: reportLoading } = useComplianceReport();
const { items, error: presetError, isLoading: presetLoading, apply } = usePreset();

// The documents' language starts as the reader's own where the documents have it, and is theirs to change.
const language = ref<`pl` | `en`>(documentLanguageFor(activeLocale.value));
const LANGUAGES = [
    { label: `Polski`, value: `pl` as const },
    { label: `English`, value: `en` as const },
];
const DOCUMENTS: readonly ComplianceDocumentKind[] = [`ropa`, `dpia`, `toms`];
const downloading = ref<string>();
const downloadError = ref<NoticeModel>();
const download = async (kind: ComplianceDocumentKind, format: ComplianceDocumentFormat): Promise<void> => {
    downloading.value = `${kind}.${format}`;
    downloadError.value = undefined;
    try {
        await downloadDocument(kind, language.value, format);
    } catch (error) {
        downloadError.value = noticeFrom(error, t(`sandbox.dataProtection.couldntDownload`));
    } finally {
        downloading.value = undefined;
    }
};

const flowGroups = computed(() => groupFlows(report.value?.flows ?? []));
const CATEGORIES: readonly MeasureCategory[] = [`confidentiality`, `minimisation`, `integrity`, `accountability`, `transparency`, `availability`];
const measuresIn = (category: MeasureCategory): readonly Measure[] => (report.value?.measures ?? []).filter((measure) => measure.category === category);

const flowTitle = (flow: DataFlow): string => {
    const kind = t(`sandbox.dataProtection.kind.${keyOf(flow.kind)}`);
    // A name that is only the kind again (`web search`) adds nothing; a provider's or connector's own name does.
    const who = flow.operator ?? (flow.hosts.length > 0 || flow.kind === `team-chat` ? flow.name : undefined);
    return who === undefined || kind.toLowerCase().includes(who.toLowerCase()) ? kind : `${kind} · ${who}`;
};

// What the preset would change, and what it would not: an item already in place, or one this sandbox cannot take.
const changeable = computed(() => (items.value ?? []).filter((item) => item.changes && item.available));
const settled = computed(() => (items.value ?? []).filter((item) => !item.changes || !item.available));
const chosen = ref<Set<string> | undefined>();
// Every change starts ticked: the preset is a recommendation, and unticking is the deliberate act.
const picked = computed<ReadonlySet<string>>(() => chosen.value ?? new Set(changeable.value.map((item) => item.id)));
const toggle = (item: PresetItem, on: boolean): void => {
    const next = new Set(picked.value);
    if (on) {
        next.add(item.id);
    } else {
        next.delete(item.id);
    }
    chosen.value = next;
};
const pickedItems = computed(() => changeable.value.filter((item) => picked.value.has(item.id)));

const confirming = ref(false);
const outcome = ref<NoticeModel>();
const applyPicked = async (): Promise<void> => {
    confirming.value = false;
    outcome.value = undefined;
    try {
        const result = await apply.mutateAsync(pickedItems.value.map((item) => item.id));
        chosen.value = undefined;
        const done: NoticeModel = { tone: `success`, title: t(`sandbox.dataProtection.applied`, { count: result.applied.length }, result.applied.length) };
        outcome.value =
            result.skipped.length === 0 ? done : { ...done, detail: t(`sandbox.dataProtection.skipped`, { count: result.skipped.length }, result.skipped.length) };
    } catch (error) {
        outcome.value = noticeFrom(error, t(`sandbox.dataProtection.couldntApply`));
    }
};

const pageNotice = computed<NoticeModel | undefined>(() =>
    reportError.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.dataProtection.couldntRead`), detail: reportError.value },
);
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <p class="text-xs text-muted">{{ t(`sandbox.dataProtection.intro`) }}</p>
        <Notice v-if="pageNotice" :of="pageNotice" />

        <RowGroup :label="t(`sandbox.dataProtection.documents`)" :caption="t(`sandbox.dataProtection.documentsCaption`)">
            <Row icon="globe" :title="t(`sandbox.dataProtection.language`)" :description="t(`sandbox.dataProtection.languageNote`)">
                <template #control>
                    <SegmentedControl v-model="language" :options="LANGUAGES" :aria-label="t(`sandbox.dataProtection.language`)" />
                </template>
            </Row>
            <Row
                v-for="kind in DOCUMENTS"
                :key="kind"
                icon="file"
                :title="t(`sandbox.dataProtection.document.${kind}`)"
                :description="t(`sandbox.dataProtection.document.${kind}Note`)"
            >
                <template #control>
                    <div class="flex gap-2">
                        <Button size="small" tier="quiet" :loading="downloading === `${kind}.md`" @click="download(kind, `md`)">{{
                            t(`sandbox.dataProtection.formatMarkdown`)
                        }}</Button>
                        <Button size="small" tier="quiet" :loading="downloading === `${kind}.docx`" @click="download(kind, `docx`)">{{
                            t(`sandbox.dataProtection.formatWord`)
                        }}</Button>
                    </div>
                </template>
            </Row>
            <RowNote v-if="downloadError" variant="block"><Notice :of="downloadError" /></RowNote>
        </RowGroup>

        <section class="flex flex-col gap-3">
            <div>
                <h2 class="text-sm font-semibold text-content">{{ t(`sandbox.dataProtection.flows`) }}</h2>
                <p class="text-xs text-muted">{{ t(`sandbox.dataProtection.flowsNote`) }}</p>
            </div>
            <SkeletonRows v-if="reportLoading" :rows="6" />
            <RowGroup v-for="entry in flowGroups" :key="entry.group" :label="t(`sandbox.dataProtection.group.${entry.group}`)">
                <Row
                    v-for="flow in entry.flows"
                    :key="flow.id"
                    :title="flowTitle(flow)"
                    :description="t(`sandbox.dataProtection.data.${keyOf(flow.kind)}`)"
                    :class="{ 'opacity-60': !flow.active }"
                >
                    <template #meta>
                        <div class="flex flex-wrap items-center gap-1.5">
                            <StatusBadge v-if="!flow.active" variant="neutral" size="xs" :label="t(`sandbox.dataProtection.notInUse`)" />
                            <StatusBadge
                                :variant="PERSONAL_TONE[flow.personalData]"
                                size="xs"
                                :label="t(`sandbox.dataProtection.personal.${flow.personalData}`)"
                            />
                            <!-- Whether the shield covers a path says nothing where no personal data travels on it. -->
                            <StatusBadge
                                v-if="flow.personalData !== `no`"
                                :variant="SHIELD_TONE[flow.shield]"
                                size="xs"
                                :label="t(`sandbox.dataProtection.shield.${flow.shield}`)"
                            />
                            <!-- normal-case: the pill lowercases its words, and EEA / EOG are abbreviations. -->
                            <StatusBadge v-if="flow.thirdCountry" variant="warning" size="xs">
                                <span class="normal-case">{{ t(`sandbox.dataProtection.outsideEea`) }}</span>
                            </StatusBadge>
                        </div>
                    </template>
                    <template v-if="flow.hosts.length > 0 || flow.question !== undefined" #below>
                        <div class="flex flex-col gap-1">
                            <p v-if="flow.hosts.length > 0" class="font-mono text-2xs text-muted">
                                {{ flow.hosts.join(` · `) }}<template v-if="flow.region"> · {{ flow.region }}</template>
                            </p>
                            <p v-if="flow.question !== undefined" class="text-2xs text-warning">
                                {{ t(`sandbox.dataProtection.officeAnswers`) }} {{ questionText(flow.question) }}
                            </p>
                        </div>
                    </template>
                </Row>
            </RowGroup>
        </section>

        <section class="flex flex-col gap-3">
            <div>
                <h2 class="text-sm font-semibold text-content">{{ t(`sandbox.dataProtection.measures`) }}</h2>
                <p class="text-xs text-muted">{{ t(`sandbox.dataProtection.measuresNote`) }}</p>
            </div>
            <SkeletonRows v-if="reportLoading" :rows="6" />
            <template v-for="category in CATEGORIES" :key="category">
                <RowGroup v-if="measuresIn(category).length > 0" :label="t(`sandbox.dataProtection.category.${category}`)">
                    <Row
                        v-for="measure in measuresIn(category)"
                        :key="measure.id"
                        :title="t(`sandbox.dataProtection.measure.${keyOf(measure.id)}.name`)"
                        :description="t(`sandbox.dataProtection.measure.${keyOf(measure.id)}.what`)"
                    >
                        <template #control>
                            <div class="flex items-center gap-2">
                                <StatusBadge :variant="STATUS_TONE[measure.status]" dot :label="t(`sandbox.dataProtection.status.${measure.status}`)" />
                                <Button
                                    v-if="MEASURE_LINKS.has(measure.id)"
                                    :as="RouterLink"
                                    :to="MEASURE_LINKS.get(measure.id)"
                                    size="small"
                                    tier="quiet"
                                    tone="accent"
                                >
                                    {{ t(`sandbox.dataProtection.change`) }}
                                </Button>
                                <a v-else-if="measure.preset" href="#preset" class="text-2xs text-muted">{{ t(`sandbox.dataProtection.inPreset`) }}</a>
                            </div>
                        </template>
                    </Row>
                </RowGroup>
            </template>
        </section>

        <section id="preset" class="flex flex-col gap-3">
            <div>
                <h2 class="text-sm font-semibold text-content">{{ t(`sandbox.dataProtection.preset`) }}</h2>
                <p class="text-xs text-muted">{{ t(`sandbox.dataProtection.presetNote`) }}</p>
            </div>
            <Notice v-if="presetError" tone="danger" :title="t(`sandbox.dataProtection.couldntReadPreset`)">{{ presetError }}</Notice>
            <Notice v-if="!isOwner" tone="info">{{ t(`sandbox.dataProtection.ownerApplies`) }}</Notice>
            <SkeletonRows v-if="presetLoading" :rows="6" />
            <RowGroup v-if="changeable.length > 0" :label="t(`sandbox.dataProtection.toChange`)" :count="changeable.length">
                <Row v-for="item in changeable" :key="item.id" as="label" :title="presetLabel(item)">
                    <template #lead>
                        <Checkbox
                            :model-value="picked.has(item.id)"
                            binary
                            size="small"
                            :disabled="!isOwner"
                            :input-id="`preset-${item.id}`"
                            @update:model-value="(on: unknown) => toggle(item, on === true)"
                        />
                    </template>
                    <template #description>
                        <span>{{ presetValue(item, item.current) }}</span>
                        <span class="px-1 text-muted">→</span>
                        <span class="font-medium text-content">{{ presetValue(item, item.proposed) }}</span>
                    </template>
                </Row>
            </RowGroup>
            <div v-if="changeable.length > 0" class="flex items-center gap-3">
                <Button tone="accent" :disabled="!isOwner || pickedItems.length === 0" :loading="apply.isPending.value" @click="confirming = true">
                    {{ t(`sandbox.dataProtection.apply`, { count: pickedItems.length }, pickedItems.length) }}
                </Button>
            </div>
            <p v-else-if="items !== undefined" class="text-xs text-muted">{{ t(`sandbox.dataProtection.nothingToChange`) }}</p>
            <Notice v-if="outcome" :of="outcome" />
            <RowGroup v-if="settled.length > 0" :label="t(`sandbox.dataProtection.alreadySet`)" :count="settled.length">
                <Row v-for="item in settled" :key="item.id" :title="presetLabel(item)" class="opacity-70">
                    <template #description>
                        {{ item.available ? presetValue(item, item.current) : t(`sandbox.dataProtection.unavailable.${keyOf(item.id)}`) }}
                    </template>
                </Row>
            </RowGroup>
        </section>

        <ConfirmDialog
            :open="confirming"
            :header="t(`sandbox.dataProtection.confirmHeader`)"
            :description="t(`sandbox.dataProtection.confirmDescription`)"
            :confirm-label="t(`sandbox.dataProtection.apply`, { count: pickedItems.length }, pickedItems.length)"
            :destructive="false"
            :items="pickedItems"
            size="md"
            @cancel="confirming = false"
            @confirm="applyPicked"
        >
            <template #item="{ item }">{{ presetLabel(item) }}: {{ presetValue(item, item.current) }} → {{ presetValue(item, item.proposed) }}</template>
        </ConfirmDialog>
    </div>
</template>
