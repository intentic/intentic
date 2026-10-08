<script setup lang="ts">
import type { PersonalDataClass, PrivacyLedgerEntry, PrivacyProvider, PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import {
    Button,
    formatDateTime,
    formatDayMonthTime,
    Icon,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    type RowTone,
    StatusBadge,
    timeAgo,
} from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { type ActivityFinding, activityFindings, activitySummary, allowKey, excerptParts, findingTokens } from "./privacyShield";
import PrivacyProviderMark from "./PrivacyProviderMark.vue";
import { usePrivacyReveal } from "./usePrivacyShield";

// What the shield did lately, kept short: one line for every request the log holds, then the newest things worth a row
// of their own: each value replaced, as the value, the token it became and the text around it as the provider read it,
// and each request refused or carrying images or documents. Hundreds of requests that found nothing are one count, not
// hundreds of rows. The values are read back from the vault for the owner alone; anybody else sees the tokens.

const t = useT();

const { entries, providers, policy, ready, error, notice } = defineProps<{
    entries: readonly PrivacyLedgerEntry[];
    providers: readonly PrivacyProvider[];
    policy: PrivacyShieldPolicy | undefined;
    ready: boolean;
    error: string | undefined;
    // A refused "never mask" press, said where it was pressed.
    notice: NoticeModel | undefined;
}>();

// The value pressed as one the shield should leave alone: the page adds it to the never-masked list.
const emit = defineEmits<{ neverMask: [value: string] }>();

// The short word a row's kind chip uses, the same as the checkboxes' long names above say in full.
const KINDS = computed(
    () =>
        ({
            "person-name": t(`sandbox.agentPrivacyShield.short.personName`),
            "national-id": t(`sandbox.agentPrivacyShield.short.nationalId`),
            "tax-id": t(`sandbox.agentPrivacyShield.short.taxId`),
            "identity-document": t(`sandbox.agentPrivacyShield.short.identityDocument`),
            "bank-account": t(`sandbox.agentPrivacyShield.short.bankAccount`),
            "payment-card": t(`sandbox.agentPrivacyShield.short.paymentCard`),
            email: t(`sandbox.agentPrivacyShield.short.email`),
            phone: t(`sandbox.agentPrivacyShield.short.phone`),
            address: t(`sandbox.agentPrivacyShield.short.address`),
        }) satisfies Record<PersonalDataClass, string>,
);

const summary = computed(() => activitySummary(entries));
const findings = computed(() => activityFindings(entries));

// The newest few, which is what "what is it doing right now" needs; the rest of what the log holds one press away.
const FEW = 5;
const MANY = 30;
const expanded = ref(false);
const shown = computed(() => findings.value.slice(0, expanded.value ? MANY : FEW));
const hidden = computed(() => Math.min(findings.value.length, MANY) - shown.value.length);

const { values, refused: revealRefused } = usePrivacyReveal(computed(() => findingTokens(shown.value)));

const providerOf = (id: string): PrivacyProvider | undefined => providers.find((provider) => provider.id === id);
const providerLabel = (id: string): string => providerOf(id)?.label ?? id;
// The summary names every provider; a finding names its own only when the findings came from more than one.
const severalProviders = computed(() => new Set(findings.value.map((finding) => finding.provider)).size > 1);

// Read as the shield reads it, so a value listed in other letter case still shows as left alone.
const allowed = computed(() => new Set((policy?.allow ?? []).map(allowKey)));

// The summary's facts, the ones with something to say.
const facts = computed(() => {
    const { values: found, images, documents, refused } = summary.value;
    return [
        found > 0 ? { text: t(`sandbox.agentPrivacyShield.valuesFound`, { count: formatFixed(found, 0) }, found), tone: `text-content` } : undefined,
        images > 0 ? { text: t(`sandbox.agentPrivacyShield.imagesCount`, { count: images }, images), tone: `text-content` } : undefined,
        documents > 0 ? { text: t(`sandbox.agentPrivacyShield.documentsCount`, { count: documents }, documents), tone: `text-content` } : undefined,
        refused > 0 ? { text: t(`sandbox.agentPrivacyShield.refusedCount`, { count: refused }, refused), tone: `text-danger` } : undefined,
    ].filter((fact) => fact !== undefined);
});

// Each finding with what its row draws worked out once: the lead, the value behind its token where the owner may read
// it, the excerpt cut at its tokens, and whether its provider runs here.
const rows = computed(() =>
    shown.value.map((finding) => ({
        finding,
        lead: leadOf(finding),
        value: finding.kind === `value` ? values.value[finding.replacement.token] : undefined,
        parts: finding.kind === `value` ? excerptParts(finding.replacement.excerpt, finding.replacement.token) : [],
        local: providerOf(finding.provider)?.local ?? false,
    })),
);

// How each finding leads: masked is done, watched is what would have been, refused never left.
const leadOf = (finding: ActivityFinding): { icon: `eye-slash` | `eye` | `times` | `image` | `file`; tone: RowTone } => {
    if (finding.action === `refused`) {
        return { icon: `times`, tone: `danger` };
    }
    const tone: RowTone = finding.action === `watched` ? `info` : `success`;
    if (finding.kind === `request` && finding.found.total === 0) {
        return { icon: finding.images > 0 ? `image` : `file`, tone };
    }
    return { icon: finding.action === `watched` ? `eye` : `eye-slash`, tone };
};
</script>

<template>
    <RowGroup :label="t(`sandbox.agentPrivacyShield.activity`)">
        <RowNote v-if="error !== undefined" variant="block"
            ><Notice tone="danger">{{ error }}</Notice></RowNote
        >

        <RowNote v-else-if="entries.length === 0" variant="empty">{{ t(`sandbox.agentPrivacyShield.noActivity`) }}</RowNote>

        <template v-else>
            <!-- Every request the log holds, as one line: how many, what they carried, and who they went to. -->
            <Row icon="shield" :tone="summary.refused > 0 ? `danger` : summary.values > 0 ? `success` : `default`">
                <template #title>
                    {{ t(`sandbox.agentPrivacyShield.requestsChecked`, { count: formatFixed(summary.requests, 0) }, summary.requests) }}
                </template>
                <template #description>
                    <span class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <template v-for="(fact, index) in facts" :key="fact.text">
                            <span v-if="index > 0" class="text-subtle" aria-hidden="true">·</span>
                            <span :class="fact.tone">{{ fact.text }}</span>
                        </template>
                        <span v-if="facts.length === 0">{{ t(`sandbox.agentPrivacyShield.nothingFoundYet`) }}</span>
                        <template v-if="summary.since !== undefined">
                            <span class="text-subtle" aria-hidden="true">·</span>
                            <span v-tooltip.top="formatDateTime(summary.since)">{{
                                t(`sandbox.agentPrivacyShield.since`, { time: formatDayMonthTime(summary.since) })
                            }}</span>
                        </template>
                    </span>
                </template>
                <template #meta>
                    <span
                        v-for="share in summary.providers"
                        :key="share.provider"
                        v-tooltip.top="
                            `${providerLabel(share.provider)} · ${share.trusted ? t(`sandbox.agentPrivacyShield.trusted`) : t(`sandbox.agentPrivacyShield.untrusted`)}`
                        "
                        class="inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2 py-1 text-content"
                    >
                        <PrivacyProviderMark :provider="share.provider" :local="providerOf(share.provider)?.local ?? false" class="text-xs" />
                        <span class="text-2xs">{{ providerLabel(share.provider) }}</span>
                        <span class="tabular-nums text-subtle">{{ formatFixed(share.requests, 0) }}</span>
                    </span>
                </template>
            </Row>

            <RowNote v-if="findings.length === 0">{{ t(`sandbox.agentPrivacyShield.nothingToShow`) }}</RowNote>

            <template v-for="row in rows" :key="row.finding.key">
                <!-- A value replaced: what it was, what the provider read instead, and the words around it as they left. -->
                <Row v-if="row.finding.kind === `value`" :icon="row.lead.icon" :tone="row.lead.tone" indent>
                    <template #title>
                        <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <template v-if="row.value !== undefined">
                                <span class="min-w-0 truncate" v-tooltip.top.overflow="row.value">{{ row.value }}</span>
                                <Icon name="arrow-right" class="shrink-0 text-3xs text-subtle" />
                            </template>
                            <code class="shrink-0 rounded bg-primary-500/10 px-1.5 py-0.5 font-mono text-2xs font-normal text-primary-500">{{
                                row.finding.replacement.token
                            }}</code>
                            <span class="shrink-0 rounded bg-content/5 px-1.5 py-0.5 text-3xs font-normal text-subtle">{{
                                KINDS[row.finding.replacement.class]
                            }}</span>
                        </span>
                    </template>
                    <template #meta>
                        <StatusBadge
                            v-if="row.finding.action === `watched`"
                            variant="info"
                            :label="t(`sandbox.agentPrivacyShield.watched`)"
                            size="xs"
                            dot
                        />
                        <span v-if="severalProviders" class="inline-flex items-center gap-1">
                            <PrivacyProviderMark :provider="row.finding.provider" :local="row.local" />
                            {{ providerLabel(row.finding.provider) }}
                        </span>
                        <span
                            v-if="row.finding.requests > 1"
                            v-tooltip.top="t(`sandbox.agentPrivacyShield.inRequests`, { count: row.finding.requests }, row.finding.requests)"
                            >×{{ row.finding.requests }}</span
                        >
                        <span v-if="row.finding.at !== undefined" v-tooltip.top="formatDateTime(row.finding.at)">{{ timeAgo(row.finding.at) }}</span>
                    </template>
                    <template #below>
                        <!-- The text as it left this machine (as it would have, while watching), set apart as a quote of what the
                             provider read: every token marked, this row's own the strongest. -->
                        <!-- `anywhere`, not `break-words`: a tool's JSON has no space to break at, and must still stay inside its box. -->
                        <p
                            class="rounded-md border border-line bg-content/5 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-muted [overflow-wrap:anywhere]"
                        >
                            <span v-if="row.finding.replacement.image === true" class="mr-1.5 inline-flex items-center gap-1 font-sans text-subtle">
                                <Icon name="image" />{{ t(`sandbox.agentPrivacyShield.inImage`) }}
                            </span>
                            <template v-for="(part, index) in row.parts" :key="index">
                                <span
                                    v-if="part.token"
                                    class="rounded-sm px-0.5"
                                    :class="part.own ? `bg-primary-500/15 text-primary-500` : `bg-content/10 text-content`"
                                    >{{ part.text }}</span
                                >
                                <template v-else>{{ part.text }}</template>
                            </template>
                        </p>
                    </template>
                    <template v-if="row.value !== undefined" #control>
                        <!-- A value the shield should have left alone goes on the never-masked list from where it was seen. -->
                        <span v-if="allowed.has(allowKey(row.value))" class="text-2xs text-subtle">{{ t(`sandbox.agentPrivacyShield.neverMaskedNow`) }}</span>
                        <Button v-else size="small" tier="quiet" :disabled="!ready" @click="emit(`neverMask`, row.value)">{{
                            t(`sandbox.agentPrivacyShield.neverMaskThis`)
                        }}</Button>
                    </template>
                </Row>

                <!-- A request worth its own row: refused, or carrying images or documents, or known by its counts alone. -->
                <Row v-else :icon="row.lead.icon" :tone="row.lead.tone">
                    <template #title>
                        <span v-if="row.finding.action === `refused`">{{ t(`sandbox.agentPrivacyShield.refusedRequest`) }}</span>
                        <span v-else class="flex flex-wrap items-center gap-x-1.5">
                            <span v-if="row.finding.found.total > 0">{{
                                t(`sandbox.agentPrivacyShield.valuesFound`, { count: row.finding.found.total }, row.finding.found.total)
                            }}</span>
                            <span v-if="row.finding.images > 0">{{
                                t(`sandbox.agentPrivacyShield.imagesCount`, { count: row.finding.images }, row.finding.images)
                            }}</span>
                            <span v-if="row.finding.documents > 0">{{
                                t(`sandbox.agentPrivacyShield.documentsCount`, { count: row.finding.documents }, row.finding.documents)
                            }}</span>
                        </span>
                    </template>
                    <template #description>
                        <span v-if="row.finding.action === `refused`" class="text-danger">{{
                            row.finding.detail ?? t(`sandbox.agentPrivacyShield.refusedNote`)
                        }}</span>
                        <span v-else class="flex flex-wrap items-center gap-1.5">
                            <span>{{
                                row.finding.action === `watched`
                                    ? t(`sandbox.agentPrivacyShield.wouldMask`)
                                    : t(`sandbox.agentPrivacyShield.maskedBeforeSent`)
                            }}</span>
                            <!-- Each kind with its count, for an entry from before tokens were kept. -->
                            <span
                                v-for="part in row.finding.found.parts"
                                :key="part.kind"
                                class="rounded bg-content/5 px-1.5 py-0.5 text-3xs text-subtle"
                            >
                                {{ KINDS[part.kind] }} <span class="tabular-nums text-content">{{ part.count }}</span>
                            </span>
                        </span>
                    </template>
                    <template #meta>
                        <span v-if="severalProviders" class="inline-flex items-center gap-1">
                            <PrivacyProviderMark :provider="row.finding.provider" :local="row.local" />
                            {{ providerLabel(row.finding.provider) }}
                        </span>
                        <span v-if="row.finding.at !== undefined" v-tooltip.top="formatDateTime(row.finding.at)">{{ timeAgo(row.finding.at) }}</span>
                    </template>
                </Row>
            </template>

            <RowNote v-if="hidden > 0 || expanded" variant="action" :icon="expanded ? `chevron-up` : `chevron-down`" @click="expanded = !expanded">
                {{ expanded ? t(`sandbox.agentPrivacyShield.showFewer`) : t(`sandbox.agentPrivacyShield.showMore`, { count: hidden }, hidden) }}
            </RowNote>

            <RowNote v-if="notice !== undefined" variant="block"><Notice :of="notice" /></RowNote>

            <!-- Where the values come from, which is worth saying where a reader might wonder who else can see them. -->
            <RowNote>{{ revealRefused ? t(`sandbox.agentPrivacyShield.activityNoteMember`) : t(`sandbox.agentPrivacyShield.activityNote`) }}</RowNote>
        </template>
    </RowGroup>
</template>
