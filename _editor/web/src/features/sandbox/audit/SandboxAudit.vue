<script setup lang="ts">
import { AUDIT_RETENTION_DAYS_DEFAULT, type AuditSettings } from "@intentic/sandbox-contract/schemas/data-protection";
import {
    AnchoredOverlay,
    Button,
    CopyButton,
    DisclosureRow,
    FilterBar,
    formatDateTime,
    Icon,
    type IconName,
    InfoHint,
    Notice,
    type NoticeModel,
    Picker,
    Row,
    RowGroup,
    RowNote,
    SegmentedControl,
    SkeletonRows,
    StatusBadge,
    type Tip,
    toneInk,
    toneWash,
    ui,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatClock, formatTimestamp } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useSecretInventory } from "../../../models/capabilities/useSecrets";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import {
    actionFilters,
    actionIcon,
    actionTitle,
    actorLine,
    actorShort,
    type AuditEntry,
    byDay,
    detailLines,
    entryActor,
    type ExportPreset,
    exportSpan,
    presetDays,
    toEntries,
    verdictLine,
} from "./auditRows";
import { downloadAudit, useAuditLog, useAuditStatus, useAuditVerify } from "./useAudit";

// The audit trail, for the owner and maintainers. It answers "who changed this, and when", which Activity, beside it in
// Oversight (what woke the agent and what it called), does not. Two parts: the records, which are what the page is opened
// for, and how they are kept, set once and left alone.
//
// The records open on the list itself. Whether the trail is intact, whether a copy leaves the sandbox, and a period to
// download sit on one line above it, each a word and a tone with its reasons behind a hover or a press: until 2026-10-15
// they were two explanatory groups, and a reader met 470px of prose before the first record. A broken chain is the one
// state said in full above the list, since it is the one a reader must not miss. Rows are one line, say what happened
// ("Access granted", not the subject alone), fall under the day they were written, and fold a press the daemon wrote
// twice in a moment into one row.

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

type ChipTone = `success` | `warning` | `danger` | `neutral`;

/* ---- Whether the record is intact ---- */

const { verdict, error: verifyError, isChecking, recheck } = useAuditVerify();
const verdictText = computed(() => (verdict.value === undefined ? undefined : verdictLine(verdict.value)));
const status = useAuditStatus();

// The pill's one word; the sentence, how the seals work and what they cannot do are in the card behind it.
const integrity = computed<{ readonly tone: ChipTone; readonly icon: IconName; readonly label: string }>(() => {
    if (verifyError.value !== undefined) {
        return { tone: `warning`, icon: `exclamation-triangle`, label: t(`sandbox.sandboxAudit.integrityUnknown`) };
    }
    if (verdict.value === undefined) {
        return { tone: `neutral`, icon: `shield`, label: t(`sandbox.sandboxAudit.integrityChecking`) };
    }
    return verdict.value.broken === undefined
        ? { tone: `success`, icon: `shield`, label: t(`sandbox.sandboxAudit.integrityIntact`) }
        : { tone: `danger`, icon: `exclamation-triangle`, label: t(`sandbox.sandboxAudit.integrityBroken`) };
});

/* ---- How it is kept ---- */

const { settings, patch, refusal } = useSandboxSettings();
const audit = computed<AuditSettings | undefined>(() => settings.value?.audit);
// How long records are kept is Retention's, beside every other record's period; it was the first row here until
// 2026-10-16. This part says the number and the way there, since it is the first thing asked of a trail.
const RETENTION_PAGE = { name: `sandbox`, params: { tab: `retention` } } as const;
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

// The outside copy as a chip beside the integrity pill: pressing it opens the settings it is made of. Why it matters is
// the integrity card's last line; the chip's own card says only how the sending goes. Absent until the settings are
// read, and for a forwarded trail until the daemon has said how the sending goes.
const outsideCopy = computed<{ readonly tone: ChipTone; readonly label: string; readonly tip: Tip } | undefined>(() => {
    if (audit.value === undefined) {
        return undefined;
    }
    const title = t(`sandbox.sandboxAudit.outsideTitle`);
    if (!forwarded.value) {
        return { tone: `neutral`, label: t(`sandbox.sandboxAudit.outsideNone`), tip: { title, note: t(`sandbox.sandboxAudit.outsideNoneNote`) } };
    }
    const forwarding = status.value?.forwarding;
    if (forwarding === undefined) {
        return undefined;
    }
    const waiting = [{ label: t(`sandbox.sandboxAudit.outsideWaiting`), value: forwarding.pending }];
    if (forwarding.lastError !== undefined) {
        return { tone: `danger`, label: t(`sandbox.sandboxAudit.outsideFailing`), tip: { title, tone: `danger`, rows: waiting, note: forwarding.lastError } };
    }
    return forwarding.pending > 0
        ? {
              tone: `warning`,
              label: t(`sandbox.sandboxAudit.outsidePending`, { count: forwarding.pending }, forwarding.pending),
              tip: { title, tone: `warning`, rows: waiting },
          }
        : { tone: `success`, label: t(`sandbox.sandboxAudit.outsideSent`), tip: { title, tone: `success`, note: t(`sandbox.sandboxAudit.forwardUpToDate`) } };
});

/* ---- A period to download ---- */

const downloadOpen = ref(false);
const downloadTrigger = ref<HTMLElement>();
const PRESETS: readonly { readonly value: ExportPreset; readonly label: () => string }[] = [
    { value: `thisMonth`, label: () => t(`sandbox.sandboxAudit.presetThisMonth`) },
    { value: `lastMonth`, label: () => t(`sandbox.sandboxAudit.presetLastMonth`) },
    { value: `last30`, label: () => t(`sandbox.sandboxAudit.presetLast30`) },
];
const opening = presetDays(`thisMonth`, new Date());
const exportFrom = ref(opening.from);
const exportTo = ref(opening.to);
// Which preset the two fields spell right now, so its chip stays lit until a date is picked by hand.
const activePreset = computed(() =>
    PRESETS.find(({ value }) => {
        const days = presetDays(value, new Date());
        return days.from === exportFrom.value && days.to === exportTo.value;
    })?.value,
);
const pickPreset = (preset: ExportPreset): void => {
    const days = presetDays(preset, new Date());
    exportFrom.value = days.from;
    exportTo.value = days.to;
};
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
        } else {
            downloadOpen.value = false;
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
const days = computed(() => byDay(toEntries(records.value)));

const opened = ref<string>();
const outcomeBadge = (entry: AuditEntry): { label: string; variant: `danger` | `warning` } | undefined => {
    if (entry.outcome === `refused`) {
        return { label: t(`sandbox.sandboxAudit.refused`), variant: `warning` };
    }
    return entry.outcome === `failed` ? { label: t(`sandbox.sandboxAudit.failed`), variant: `danger` } : undefined;
};
// A row that stands for several records says so, and what the drawer will show.
const burstTip = (entry: AuditEntry): Tip => ({
    title: t(`sandbox.sandboxAudit.burstTitle`),
    note: t(`sandbox.sandboxAudit.burstNote`, { count: entry.records.length }, entry.records.length),
});
const rowTone = (entry: AuditEntry): `default` | `warning` | `danger` => {
    if (entry.outcome === `refused`) {
        return `warning`;
    }
    return entry.outcome === `failed` ? `danger` : `default`;
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- One line: which part, then the trail's state and its download, each a word with its reasons behind it. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <SegmentedControl v-model="section" :options="SECTIONS" :aria-label="t(`sandbox.sandboxAudit.part`)" />

            <div v-if="section === `records`" class="ml-auto flex flex-wrap items-center gap-2">
                <span class="inline-flex items-center gap-0.5">
                    <InfoHint :label="t(`sandbox.sandboxAudit.integrityTitle`)">
                        <template #trigger>
                            <span class="ui-status-pill gap-1.5 text-2xs font-medium" :class="toneWash(integrity.tone)">
                                <Icon :name="integrity.icon" class="text-xs" />{{ integrity.label }}
                            </span>
                        </template>
                        <span class="flex flex-col gap-2 text-2xs text-muted">
                            <span class="text-xs font-medium text-content">{{ t(`sandbox.sandboxAudit.integrityTitle`) }}</span>
                            <span v-if="verifyError !== undefined" :class="toneInk(`danger`)">{{ verifyError }}</span>
                            <span v-else-if="verdictText !== undefined" class="text-xs" :class="toneInk(verdictText.tone)">{{ verdictText.text }}</span>
                            <span>{{ t(`sandbox.sandboxAudit.integrityDescription`) }}</span>
                            <span>{{ t(`sandbox.sandboxAudit.reachNote`) }}</span>
                            <span v-if="verdict?.torn" class="text-subtle">{{ t(`sandbox.sandboxAudit.tornNote`) }}</span>
                            <span v-if="verdict?.prunedThrough !== undefined" class="text-subtle">
                                {{ t(`sandbox.sandboxAudit.prunedNote`, { date: formatDateTime(verdict.prunedThrough.at) }) }}
                            </span>
                            <span v-if="status?.oldestAt !== undefined" class="text-subtle">
                                {{ t(`sandbox.sandboxAudit.oldest`, { date: formatDateTime(status.oldestAt) }) }}
                            </span>
                        </span>
                    </InfoHint>
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `sm`, tone: `subtle` })"
                        :disabled="isChecking"
                        :aria-label="t(`sandbox.sandboxAudit.checkAgain`)"
                        v-tooltip.bottom="t(`sandbox.sandboxAudit.checkAgain`)"
                        @click="void recheck()"
                    >
                        <Icon name="refresh" class="text-2xs" :class="isChecking ? `animate-spin` : ``" />
                    </button>
                </span>

                <button v-if="outsideCopy !== undefined" type="button" :class="ui.chip()" v-tooltip.bottom="outsideCopy.tip" @click="section = `keeping`">
                    <Icon name="external-link" class="text-xs" :class="toneInk(outsideCopy.tone)" />{{ outsideCopy.label }}
                </button>

                <span ref="downloadTrigger" class="inline-flex">
                    <Button :label="t(`sandbox.sandboxAudit.downloadButton`)" size="small" tier="boring" :aria-expanded="downloadOpen" @click="downloadOpen = !downloadOpen">
                        <template #icon><Icon name="download" /></template>
                    </Button>
                </span>
                <AnchoredOverlay v-model="downloadOpen" :anchor="downloadTrigger" side="bottom" cross="end">
                    <div class="flex w-80 max-w-full flex-col gap-3 p-3">
                        <div class="flex flex-col gap-0.5">
                            <span class="text-xs font-medium text-content">{{ t(`sandbox.sandboxAudit.downloadTitle`) }}</span>
                            <span class="text-2xs text-muted">{{ t(`sandbox.sandboxAudit.downloadDescription`) }}</span>
                        </div>
                        <div class="flex flex-wrap gap-1.5">
                            <button
                                v-for="preset in PRESETS"
                                :key="preset.value"
                                type="button"
                                :class="ui.chip({ on: activePreset === preset.value })"
                                :aria-pressed="activePreset === preset.value"
                                @click="pickPreset(preset.value)"
                            >
                                {{ preset.label() }}
                            </button>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            <label class="ui-field">
                                <span class="ui-field-label">{{ t(`sandbox.sandboxAudit.from`) }}</span>
                                <input v-model="exportFrom" type="date" :class="ui.input({ size: `sm` })" />
                            </label>
                            <label class="ui-field">
                                <span class="ui-field-label">{{ t(`sandbox.sandboxAudit.to`) }}</span>
                                <input v-model="exportTo" type="date" :class="ui.input({ size: `sm` })" />
                            </label>
                        </div>
                        <Notice v-if="exportNotice !== undefined" :of="exportNotice" />
                        <Button :label="t(`sandbox.sandboxAudit.downloadButton`)" size="small" class="self-end" :loading="exporting" @click="void runExport()">
                            <template #icon><Icon name="download" /></template>
                        </Button>
                    </div>
                </AnchoredOverlay>
            </div>
        </div>

        <template v-if="section === `records`">
            <!-- Said whole, not behind the pill: an altered record is the one state on this page nobody may miss. -->
            <Notice v-if="verdictText?.tone === `danger`" tone="danger">{{ verdictText.text }}</Notice>

            <FilterBar
                v-model="actorQuery"
                :placeholder="t(`sandbox.sandboxAudit.filterPlaceholder`)"
                :count="records.length"
                :busy="isLoading"
                clearable
            >
                <template #controls>
                    <SegmentedControl v-model="actionFilter" size="xs" :options="actionFilters()" />
                </template>
            </FilterBar>

            <section :aria-label="t(`sandbox.sandboxAudit.records`)">
                <Notice v-if="listError !== undefined" tone="danger">{{ listError }}</Notice>
                <div v-else-if="isLoading" class="overflow-hidden rounded-xl bg-card shadow-sm" role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.sandboxAudit.reading`) }}</span>
                    <div class="flex flex-col divide-y divide-line-subtle/50"><SkeletonRows :rows="8" density="compact" /></div>
                </div>
                <p v-else-if="days.length === 0" :class="ui.emptyState(`py-10`)">{{ t(`sandbox.sandboxAudit.empty`) }}</p>
                <!-- `overflow-clip`, not `hidden`: it rounds the rows' corners without becoming the scroller the day headings stick to. -->
                <div v-else class="overflow-clip rounded-xl bg-card shadow-sm">
                    <div v-for="day in days" :key="day.label">
                        <div class="sticky top-0 z-1 flex items-center justify-between border-b border-line-subtle bg-card px-4 py-2">
                            <h3 class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ day.label }}</h3>
                            <span class="text-2xs tabular-nums text-subtle">{{ t(`sandbox.sandboxAudit.dayRecords`, { count: day.records }, day.records) }}</span>
                        </div>
                        <div class="flex flex-col divide-y divide-line-subtle/50">
                            <DisclosureRow
                                v-for="entry in day.entries"
                                :key="entry.key"
                                density="compact"
                                body="rail"
                                :icon="actionIcon(entry.action)"
                                :tone="rowTone(entry)"
                                :open="opened === entry.key"
                                @update:open="(open: boolean) => (opened = open ? entry.key : undefined)"
                            >
                                <template #title>
                                    <!-- The target claims no width of its own (`w-0 grow`): it fills what the action and the facts leave and is cut
                                         first, so a long id never pushes who and when onto a second line. -->
                                    <span class="flex min-w-0 items-baseline gap-1.5 text-xs">
                                        <span class="shrink-0 font-medium text-content">{{ actionTitle(entry.action) }}</span>
                                        <span v-if="entry.target !== undefined" class="w-0 min-w-0 grow truncate font-normal text-muted" v-tooltip.top.overflow="entry.target">
                                            {{ entry.target }}
                                        </span>
                                    </span>
                                </template>
                                <template #meta>
                                    <StatusBadge v-if="outcomeBadge(entry) !== undefined" :variant="outcomeBadge(entry)!.variant" :label="outcomeBadge(entry)!.label" size="xs" />
                                    <span v-if="entry.records.length > 1" class="text-2xs tabular-nums text-subtle" v-tooltip.top="burstTip(entry)">
                                        ×{{ entry.records.length }}
                                    </span>
                                    <span class="max-w-48 truncate text-2xs text-muted" v-tooltip.top.overflow="actorShort(entryActor(entry).actor)">
                                        {{ actorShort(entryActor(entry).actor) }}<span v-if="entryActor(entry).others > 0" class="text-subtle"> +{{ entryActor(entry).others }}</span>
                                    </span>
                                    <span class="w-9 shrink-0 text-right text-2xs tabular-nums text-subtle" v-tooltip.top="formatTimestamp(entry.at)">
                                        {{ formatClock(entry.at) }}
                                    </span>
                                </template>
                                <!-- What the record says, then each record the row stands for: when, who, and its seal. -->
                                <template #below>
                                    <div class="flex flex-col gap-2 pb-1 text-2xs">
                                        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                                            <dt class="text-subtle">{{ t(`sandbox.sandboxAudit.action`) }}</dt>
                                            <dd class="font-mono text-content">{{ entry.action }}</dd>
                                            <template v-if="entry.target !== undefined">
                                                <dt class="text-subtle">{{ t(`sandbox.sandboxAudit.target`) }}</dt>
                                                <dd class="text-content [overflow-wrap:anywhere]">{{ entry.target }}</dd>
                                            </template>
                                            <template v-if="detailLines(entry).length > 0">
                                                <dt class="text-subtle">{{ t(`sandbox.sandboxAudit.details`) }}</dt>
                                                <dd class="font-mono text-content [overflow-wrap:anywhere]">
                                                    <div v-for="line in detailLines(entry)" :key="line">{{ line }}</div>
                                                </dd>
                                            </template>
                                        </dl>
                                        <ul class="flex flex-col gap-0.5 border-t border-line-subtle pt-2">
                                            <li v-for="record in entry.records" :key="record.id" class="flex min-w-0 items-center gap-3">
                                                <span class="shrink-0 tabular-nums text-subtle">{{ formatTimestamp(record.at) }}</span>
                                                <span class="min-w-0 flex-1 truncate text-content" v-tooltip.top.overflow="actorLine(record.actor)">{{ actorLine(record.actor) }}</span>
                                                <span class="flex shrink-0 items-center gap-1 font-mono text-subtle">
                                                    {{ t(`sandbox.sandboxAudit.hash`) }} {{ record.hash.slice(0, 8) }}…
                                                    <CopyButton :text="record.hash" />
                                                </span>
                                            </li>
                                        </ul>
                                    </div>
                                </template>
                            </DisclosureRow>
                        </div>
                    </div>
                    <div v-if="hasOlder" class="flex justify-center border-t border-line-subtle px-4 py-2">
                        <Button :label="t(`sandbox.sandboxAudit.showOlder`)" size="small" tier="quiet" :loading="loadingOlder" @click="void loadOlder()" />
                    </div>
                </div>
                <p v-if="!hasOlder && status?.oldestAt !== undefined && days.length > 0" class="mt-2 px-1 text-2xs text-subtle">
                    {{ t(`sandbox.sandboxAudit.oldest`, { date: formatDateTime(status.oldestAt) }) }}
                </p>
            </section>
        </template>

        <RowGroup v-else :label="t(`sandbox.sandboxAudit.keeping`)">
            <RowNote>
                {{ t(`sandbox.sandboxAudit.keptFor`, { count: audit?.retentionDays ?? AUDIT_RETENTION_DAYS_DEFAULT }, audit?.retentionDays ?? AUDIT_RETENTION_DAYS_DEFAULT) }}
                <RouterLink :to="RETENTION_PAGE" :class="ui.textButton()">{{ t(`sandbox.sandboxNav.retention`) }}<Icon name="arrow-right" class="text-2xs" /></RouterLink>
            </RowNote>
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
                        <p v-if="forwardingLine !== undefined" class="text-xs" :class="toneInk(forwardingLine.tone)">{{ forwardingLine.text }}</p>
                    </div>
                </template>
            </Row>
            <RowNote v-if="refusal !== undefined" variant="block"><Notice :of="refusal" /></RowNote>
        </RowGroup>
    </div>
</template>
