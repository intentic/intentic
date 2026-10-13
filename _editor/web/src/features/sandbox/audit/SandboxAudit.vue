<script setup lang="ts">
import type { AuditRecord, AuditSettings } from "@intentic/sandbox-contract";
import {
    Button,
    DisclosureRow,
    FilterBar,
    formatDateTime,
    Icon,
    Notice,
    type NoticeModel,
    Picker,
    Row,
    RowGroup,
    RowNote,
    SegmentedControl,
    SkeletonRows,
    StatusBadge,
    timeAgo,
    ui,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSecretInventory } from "../../capabilities/connect/secrets/useSecrets";
import { commitCount } from "../agent-settings/models/numberInputs";
import { useSandboxSettings } from "../overview/useSandboxSettings";
import { actionFilters, actionTitle, actorLine, detailLines, exportSpan, verdictLine } from "./auditRows";
import { downloadAudit, useAuditLog, useAuditStatus, useAuditVerify } from "./useAudit";

// The audit trail, for the owner and maintainers. It answers "who changed this, and when", which Activity, beside it in
// Oversight (what woke the agent and what it called), does not. Two parts: the records, which are what the page is opened
// for, under whether they are intact and with a period to download; and how they are kept, set once and left alone. The
// settings led the page until 2026-10-13, and a reader looking for who changed something met three groups of controls
// before the first record. They live here rather than on the Agent tab, beside the record they shape.

const t = useT();

const SECTIONS = computed(
    () =>
        [
            { label: t(`sandbox.sandboxAudit.records`), value: `records` },
            { label: t(`sandbox.sandboxAudit.keeping`), value: `keeping` },
        ] as const,
);
type Section = (typeof SECTIONS.value)[number][`value`];
const route = useRoute();
const router = useRouter();
// In the query, as the Agent tab's categories are, so Data protection's "Change" lands on the settings; the default
// writes no param, and a push rather than a replace lets Back return to the records.
const section = computed<Section>({
    get: () => (route.query[`section`] === `keeping` ? `keeping` : `records`),
    set: (value) => void router.push({ query: { ...route.query, section: value === `records` ? undefined : value } }),
});

/* ---- Whether the record is intact ---- */

const { verdict, error: verifyError, isChecking, recheck } = useAuditVerify();
const verdictText = computed(() => (verdict.value === undefined ? undefined : verdictLine(verdict.value)));
const status = useAuditStatus();

/* ---- How it is kept ---- */

const { settings, patch, refusal } = useSandboxSettings();
const audit = computed<AuditSettings | undefined>(() => settings.value?.audit);
const RETENTION = { min: 30, max: 3650 };
const setAudit = (fields: Partial<AuditSettings>): void => {
    if (audit.value !== undefined) {
        patch({ audit: { ...audit.value, ...fields } });
    }
};

// An address is saved only once it is one the daemon would take: HTTPS, or empty to stop forwarding.
const urlError = ref<string>();
const commitUrl = (event: Event): void => {
    // SAFETY: bound only to the URL <input> below, whose change event targets that input.
    const value = (event.target as HTMLInputElement).value.trim();
    const valid = value === `` || URL.canParse(value) && new URL(value).protocol === `https:`;
    urlError.value = valid ? undefined : t(`sandbox.sandboxAudit.forwardUrlInvalid`);
    if (valid && value !== audit.value?.forwardUrl) {
        setAudit({ forwardUrl: value });
    }
};

// Only secrets someone stored by name can carry the token; a connection's own credential is not offered.
const { inventory } = useSecretInventory();
const NO_SECRET = `__none__`;
const secretOptions = computed(() => [
    { value: NO_SECRET, label: t(`sandbox.sandboxAudit.forwardSecretNone`) },
    ...inventory.value.filter((entry) => (entry.kind === `env` || entry.kind === `generated`) && entry.status === `set`).map((entry) => ({ value: entry.key, label: entry.key })),
]);
const pickSecret = (value: string | undefined): void => {
    if (value !== undefined) {
        setAudit({ forwardSecret: value === NO_SECRET ? `` : value });
    }
};

// Spelled out whole so the stylesheet keeps each class.
const TONE_CLASS = { success: `text-success`, warning: `text-warning`, danger: `text-danger` } as const;

// Whether a copy leaves the sandbox at all: the one copy nobody inside can change, so the records say when there is none.
const forwarded = computed(() => audit.value !== undefined && audit.value.forwardUrl !== ``);

const forwardingLine = computed(() => {
    const forwarding = status.value?.forwarding;
    if (forwarding === undefined) {
        return undefined;
    }
    if (forwarding.lastError !== undefined) {
        return { tone: `danger` as const, text: t(`sandbox.sandboxAudit.forwardFailing`, { error: forwarding.lastError, count: forwarding.pending }) };
    }
    return forwarding.pending === 0
        ? { tone: `success` as const, text: t(`sandbox.sandboxAudit.forwardUpToDate`) }
        : { tone: `warning` as const, text: t(`sandbox.sandboxAudit.forwardPending`, { count: forwarding.pending }, forwarding.pending) };
});

/* ---- A period to download ---- */

// The reader's own calendar day, as the date fields show and exportSpan reads them.
const localDay = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, `0`)}-${String(date.getDate()).padStart(2, `0`)}`;
const today = localDay(new Date());
const exportFrom = ref(`${today.slice(0, 8)}01`);
const exportTo = ref(today);
const exporting = ref(false);
const exportNotice = ref<NoticeModel>();
const runExport = async (): Promise<void> => {
    const span = exportSpan(exportFrom.value, exportTo.value);
    if (span === undefined) {
        exportNotice.value = { tone: `warning`, title: t(`sandbox.sandboxAudit.exportBadPeriod`) };
        return;
    }
    exporting.value = true;
    exportNotice.value = undefined;
    try {
        const count = await downloadAudit(span.from, span.to);
        if (count === 0) {
            exportNotice.value = { tone: `info`, title: t(`sandbox.sandboxAudit.exportEmpty`) };
        }
    } catch (err) {
        exportNotice.value = noticeFrom(err, t(`sandbox.sandboxAudit.exportFailed`));
    } finally {
        exporting.value = false;
    }
};

/* ---- The records ---- */

const actorQuery = ref(``);
const actionFilter = ref(``);
const filters = computed(() => ({ actor: actorQuery.value.trim(), action: actionFilter.value === `` ? undefined : actionFilter.value }));
const { records, error: listError, isLoading, hasOlder, loadingOlder, loadOlder } = useAuditLog(filters);

const opened = ref<string>();
const outcomeBadge = (record: AuditRecord): { label: string; variant: `danger` | `warning` } | undefined => {
    if (record.outcome === `refused`) {
        return { label: t(`sandbox.sandboxAudit.refused`), variant: `warning` };
    }
    return record.outcome === `failed` ? { label: t(`sandbox.sandboxAudit.failed`), variant: `danger` } : undefined;
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <SegmentedControl v-model="section" :options="SECTIONS" :aria-label="t(`sandbox.sandboxAudit.part`)" />

        <template v-if="section === `records`">
            <RowGroup :label="t(`sandbox.sandboxAudit.integrity`)">
                <Row icon="shield" :title="t(`sandbox.sandboxAudit.integrityTitle`)" :description="t(`sandbox.sandboxAudit.integrityDescription`)">
                    <template #control>
                        <Button
                            :label="t(`sandbox.sandboxAudit.checkAgain`)"
                            size="small"
                            tier="boring"
                            :loading="isChecking"
                            @click="void recheck()"
                        />
                    </template>
                    <template #below>
                        <Notice v-if="verifyError !== undefined" tone="danger">{{ verifyError }}</Notice>
                        <p v-else-if="verdictText !== undefined" class="text-xs" :class="verdictText.tone === `success` ? `text-success` : `text-danger`">
                            {{ verdictText.text }}
                        </p>
                        <p v-if="verdict?.torn" class="mt-1 text-2xs text-muted">{{ t(`sandbox.sandboxAudit.tornNote`) }}</p>
                        <p v-if="verdict?.prunedThrough !== undefined" class="mt-1 text-2xs text-muted">
                            {{ t(`sandbox.sandboxAudit.prunedNote`, { date: formatDateTime(verdict.prunedThrough.at) }) }}
                        </p>
                        <!-- The forwarded copy is what makes the seals worth trusting, so a failing one is said beside the verdict. -->
                        <p v-if="forwardingLine?.tone === `danger`" class="mt-1 text-xs text-danger">{{ forwardingLine.text }}</p>
                    </template>
                </Row>
                <RowNote>
                    {{ t(`sandbox.sandboxAudit.reachNote`) }}
                    <button v-if="audit !== undefined && !forwarded" type="button" :class="ui.textButton()" @click="section = `keeping`">
                        {{ t(`sandbox.sandboxAudit.forwardTitle`) }}<Icon name="arrow-right" class="text-2xs" />
                    </button>
                </RowNote>
            </RowGroup>

            <RowGroup :label="t(`sandbox.sandboxAudit.download`)">
                <Row icon="download" :title="t(`sandbox.sandboxAudit.downloadTitle`)" :description="t(`sandbox.sandboxAudit.downloadDescription`)">
                    <template #below>
                        <div class="flex flex-wrap items-end gap-3">
                            <label class="ui-field">
                                <span class="ui-field-label">{{ t(`sandbox.sandboxAudit.from`) }}</span>
                                <input v-model="exportFrom" type="date" :class="ui.input({ size: `sm` })" />
                            </label>
                            <label class="ui-field">
                                <span class="ui-field-label">{{ t(`sandbox.sandboxAudit.to`) }}</span>
                                <input v-model="exportTo" type="date" :class="ui.input({ size: `sm` })" />
                            </label>
                            <Button :label="t(`sandbox.sandboxAudit.downloadButton`)" size="small" :loading="exporting" @click="void runExport()">
                                <template #icon><Icon name="download" /></template>
                            </Button>
                        </div>
                        <Notice v-if="exportNotice !== undefined" :of="exportNotice" class="mt-2" />
                    </template>
                </Row>
            </RowGroup>

            <div class="flex flex-col gap-3">
                <FilterBar v-model="actorQuery" :placeholder="t(`sandbox.sandboxAudit.filterPlaceholder`)" clearable>
                    <template #controls>
                        <SegmentedControl v-model="actionFilter" size="xs" :options="actionFilters()" />
                    </template>
                </FilterBar>

                <RowGroup :label="t(`sandbox.sandboxAudit.records`)">
                    <RowNote v-if="listError !== undefined" variant="block"><Notice tone="danger">{{ listError }}</Notice></RowNote>
                    <div v-else-if="isLoading" role="status" aria-busy="true">
                        <span class="sr-only">{{ t(`sandbox.sandboxAudit.reading`) }}</span>
                        <SkeletonRows :rows="4" description />
                    </div>
                    <RowNote v-else-if="records.length === 0" variant="empty">{{ t(`sandbox.sandboxAudit.empty`) }}</RowNote>
                    <template v-else>
                        <DisclosureRow
                            v-for="record in records"
                            :key="record.id"
                            body="rail"
                            :open="opened === record.id"
                            @update:open="(open: boolean) => (opened = open ? record.id : undefined)"
                        >
                            <template #title>
                                <span class="block truncate text-xs font-medium text-content">
                                    {{ actionTitle(record.action) }}<span v-if="record.target !== undefined" class="font-normal text-muted"> · {{ record.target }}</span>
                                </span>
                            </template>
                            <template #description>
                                <span class="block truncate text-2xs text-muted">{{ actorLine(record.actor) }}</span>
                            </template>
                            <template #meta>
                                <StatusBadge v-if="outcomeBadge(record) !== undefined" :variant="outcomeBadge(record)!.variant" :label="outcomeBadge(record)!.label" size="xs" />
                                <span class="shrink-0 text-2xs text-subtle" v-tooltip.top="formatDateTime(record.at)">{{ timeAgo(record.at) }}</span>
                            </template>
                            <template #below>
                                <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 py-1 text-2xs">
                                    <dt class="text-subtle">{{ t(`sandbox.sandboxAudit.when`) }}</dt>
                                    <dd class="text-content">{{ formatDateTime(record.at) }}</dd>
                                    <dt class="text-subtle">{{ t(`sandbox.sandboxAudit.action`) }}</dt>
                                    <dd class="font-mono text-content">{{ record.action }}</dd>
                                    <template v-if="detailLines(record).length > 0">
                                        <dt class="text-subtle">{{ t(`sandbox.sandboxAudit.details`) }}</dt>
                                        <dd class="font-mono text-content [overflow-wrap:anywhere]">
                                            <div v-for="line in detailLines(record)" :key="line">{{ line }}</div>
                                        </dd>
                                    </template>
                                    <dt class="text-subtle">{{ t(`sandbox.sandboxAudit.hash`) }}</dt>
                                    <dd class="font-mono text-subtle [overflow-wrap:anywhere]">{{ record.hash }}</dd>
                                </dl>
                            </template>
                        </DisclosureRow>
                        <RowNote v-if="hasOlder">
                            <Button :label="t(`sandbox.sandboxAudit.showOlder`)" size="small" tier="boring" :loading="loadingOlder" @click="void loadOlder()" />
                        </RowNote>
                    </template>
                </RowGroup>
                <p v-if="status?.oldestAt !== undefined" class="text-2xs text-subtle">
                    {{ t(`sandbox.sandboxAudit.oldest`, { date: formatDateTime(status.oldestAt) }) }}
                </p>
            </div>
        </template>

        <RowGroup v-else :label="t(`sandbox.sandboxAudit.keeping`)">
            <Row icon="clock" :title="t(`sandbox.sandboxAudit.retentionTitle`)" :description="t(`sandbox.sandboxAudit.retentionDescription`)">
                <template #control>
                    <input
                        type="number"
                        :min="RETENTION.min"
                        :max="RETENTION.max"
                        :value="audit?.retentionDays ?? 365"
                        :disabled="audit === undefined"
                        :aria-label="t(`sandbox.sandboxAudit.retentionTitle`)"
                        :class="ui.input({ size: `sm` }, 'w-24 text-right')"
                        @change="(event: Event) => commitCount(event, audit?.retentionDays ?? 365, RETENTION, (retentionDays: number) => setAudit({ retentionDays }))"
                    />
                </template>
            </Row>
            <Row icon="eye" :title="t(`sandbox.sandboxAudit.readsTitle`)" :description="t(`sandbox.sandboxAudit.readsDescription`)">
                <template #control>
                    <ToggleSwitch
                        :model-value="audit?.recordReads ?? false"
                        :disabled="audit === undefined"
                        :aria-label="t(`sandbox.sandboxAudit.readsTitle`)"
                        @update:model-value="(value: boolean) => setAudit({ recordReads: value })"
                    />
                </template>
            </Row>
            <Row icon="external-link" :title="t(`sandbox.sandboxAudit.forwardTitle`)" :description="t(`sandbox.sandboxAudit.forwardDescription`)">
                <template #below>
                    <div class="flex max-w-2xl flex-col gap-3">
                        <div class="ui-field">
                            <label class="ui-field-label" for="audit-forward-url">{{ t(`sandbox.sandboxAudit.forwardUrlLabel`) }}</label>
                            <input
                                id="audit-forward-url"
                                type="url"
                                :value="audit?.forwardUrl ?? ``"
                                :disabled="audit === undefined"
                                :class="ui.input()"
                                placeholder="https://"
                                @change="commitUrl"
                            />
                            <span v-if="urlError !== undefined" class="ui-field-error">{{ urlError }}</span>
                        </div>
                        <div class="ui-field">
                            <span class="ui-field-label">{{ t(`sandbox.sandboxAudit.forwardSecretLabel`) }}</span>
                            <Picker
                                :model-value="audit?.forwardSecret === `` || audit === undefined ? NO_SECRET : audit.forwardSecret"
                                :options="secretOptions"
                                :disabled="audit === undefined || audit.forwardUrl === ``"
                                :aria-label="t(`sandbox.sandboxAudit.forwardSecretLabel`)"
                                class="w-72 justify-between text-xs"
                                @update:model-value="pickSecret"
                            />
                            <span class="text-2xs text-muted">{{ t(`sandbox.sandboxAudit.forwardSecretHint`) }}</span>
                        </div>
                        <p v-if="forwardingLine !== undefined" class="text-xs" :class="TONE_CLASS[forwardingLine.tone]">{{ forwardingLine.text }}</p>
                    </div>
                </template>
            </Row>
            <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
        </RowGroup>
    </div>
</template>
