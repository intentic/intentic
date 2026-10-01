<script setup lang="ts">
import {
    PERSONAL_DATA_CLASSES,
    PRIVACY_ALLOW_MAX,
    type PersonalDataClass,
    type PrivacyImages,
    type PrivacyLedgerAction,
    type PrivacyNames,
    type PrivacyProvider,
    type PrivacyShieldMode,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract";
import {
    Button,
    formatDate,
    formatDateTime,
    Icon,
    type IconName,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    SegmentedControl,
    SkeletonRows,
    StatusBadge,
    type StatusVariant,
    timeAgo,
    ui,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useDraft } from "../../../../lib/useDraft";
import { SandboxHttpError } from "../../client/sandboxHttpError";
import {
    ALLOW_VALUE_MAX,
    allowListFrom,
    allowListProblem,
    allowListText,
    foundIn,
    ledgerTime,
    providerTrusted,
    sameList,
    withClass,
    withTrusted,
} from "./privacyShield";
import { usePrivacyLog, usePrivacyShield, usePrivacySources } from "./usePrivacyShield";

// The privacy shield: whether personal data is kept from model providers the owner does not trust, and what the
// gateway in front of them looks for. Off by default, so off draws the switch alone; the rest appears once the shield
// runs, or while it still has datasets or a record to show. The policy is the owner's alone: a member's write comes
// back 403, and the refusal is said beside the control that sent it.

const t = useT();

const { status, setPolicy, saveError, isLoading, error } = usePrivacyShield();
const { entries, isLoading: logLoading, error: logError } = usePrivacyLog();
const { sources, forget, forgetError, isLoading: sourcesLoading, error: sourcesError } = usePrivacySources();

const policy = computed<PrivacyShieldPolicy | undefined>(() => status.value?.policy);
const ready = computed(() => policy.value !== undefined);
const mode = computed<PrivacyShieldMode>(() => policy.value?.mode ?? `off`);
const running = computed(() => mode.value !== `off`);

// A switch with nothing loaded under it would write a policy built from nothing, so it looks inert until the read lands.
const INERT = `pointer-events-none opacity-60`;

// Off, watch, on, in escalating order, the same reading as the safety judge's switch above.
const MODES = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.off`), value: `off` as const },
    { label: t(`sandbox.agentPrivacyShield.watch`), value: `watch` as const },
    { label: t(`sandbox.agentPrivacyShield.on`), value: `on` as const },
]);
const modeNote = computed(
    () =>
        ({
            off: t(`sandbox.agentPrivacyShield.offNote`),
            watch: t(`sandbox.agentPrivacyShield.watchNote`),
            on: t(`sandbox.agentPrivacyShield.onNote`),
        })[mode.value],
);

const IMAGES = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.withhold`), value: `withhold` as const },
    { label: t(`sandbox.agentPrivacyShield.read`), value: `read` as const },
    { label: t(`sandbox.agentPrivacyShield.allow`), value: `allow` as const },
]);
const images = computed<PrivacyImages>(() => policy.value?.images ?? `withhold`);
const imagesNote = computed(
    () =>
        ({
            withhold: t(`sandbox.agentPrivacyShield.withholdNote`),
            read: t(`sandbox.agentPrivacyShield.readNote`),
            allow: t(`sandbox.agentPrivacyShield.allowNote`),
        })[images.value],
);
// Reading without a reader installed is withholding in practice; said, or "Read text" claims what the daemon cannot do.
const ocrMissing = computed(() => images.value === `read` && status.value?.readers.ocr === false);
// The agent's own command for the image pack, shown as written rather than translated.
const PACK_COMMAND = `environment propose privacy --pack`;

const NAMES = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.dictionary`), value: `dictionary` as const },
    { label: t(`sandbox.agentPrivacyShield.model`), value: `model` as const },
]);
const names = computed<PrivacyNames>(() => policy.value?.names ?? `dictionary`);
const namesNote = computed(() =>
    names.value === `model` ? t(`sandbox.agentPrivacyShield.modelNote`) : t(`sandbox.agentPrivacyShield.dictionaryNote`),
);
const nameModelMissing = computed(() => names.value === `model` && status.value?.readers.model === false);

// One record per kind: the checkbox's full name, and the short word a log row's breakdown uses.
const KINDS = computed(
    () =>
        ({
            "person-name": { label: t(`sandbox.agentPrivacyShield.classes.personName`), short: t(`sandbox.agentPrivacyShield.short.personName`) },
            "national-id": { label: t(`sandbox.agentPrivacyShield.classes.nationalId`), short: t(`sandbox.agentPrivacyShield.short.nationalId`) },
            "tax-id": { label: t(`sandbox.agentPrivacyShield.classes.taxId`), short: t(`sandbox.agentPrivacyShield.short.taxId`) },
            "identity-document": {
                label: t(`sandbox.agentPrivacyShield.classes.identityDocument`),
                short: t(`sandbox.agentPrivacyShield.short.identityDocument`),
            },
            "bank-account": { label: t(`sandbox.agentPrivacyShield.classes.bankAccount`), short: t(`sandbox.agentPrivacyShield.short.bankAccount`) },
            "payment-card": { label: t(`sandbox.agentPrivacyShield.classes.paymentCard`), short: t(`sandbox.agentPrivacyShield.short.paymentCard`) },
            email: { label: t(`sandbox.agentPrivacyShield.classes.email`), short: t(`sandbox.agentPrivacyShield.short.email`) },
            phone: { label: t(`sandbox.agentPrivacyShield.classes.phone`), short: t(`sandbox.agentPrivacyShield.short.phone`) },
            address: { label: t(`sandbox.agentPrivacyShield.classes.address`), short: t(`sandbox.agentPrivacyShield.short.address`) },
        }) satisfies Record<PersonalDataClass, { label: string; short: string }>,
);

// Which group sent the last write, so a refusal is said in that group and not one a scroll away from the press.
const writtenFrom = ref<`shield` | `trusted`>(`shield`);
const write = (from: `shield` | `trusted`, change: (current: PrivacyShieldPolicy) => PrivacyShieldPolicy): void => {
    writtenFrom.value = from;
    setPolicy(change);
};

// A 403 is the one refusal with a known cause: the policy is the owner's alone. Anything else keeps the daemon's words.
const refusal = (cause: Error | null, ownerOnly: string, failed: string): NoticeModel | undefined => {
    if (cause === null) {
        return undefined;
    }
    return noticeFrom(cause, cause instanceof SandboxHttpError && cause.status === 403 ? ownerOnly : failed);
};
const saveNotice = computed(() => refusal(saveError.value, t(`sandbox.agentPrivacyShield.ownerOnly`), t(`sandbox.agentPrivacyShield.couldntSave`)));
const forgetNotice = computed(() =>
    refusal(forgetError.value, t(`sandbox.agentPrivacyShield.ownerOnlyForget`), t(`sandbox.agentPrivacyShield.couldntForget`)),
);

const providers = computed<readonly PrivacyProvider[]>(() => status.value?.providers ?? []);
const providerNote = (provider: PrivacyProvider): string | undefined => {
    if (provider.local) {
        return t(`sandbox.agentPrivacyShield.localNote`);
    }
    return provider.shieldable ? undefined : t(`sandbox.agentPrivacyShield.unshieldableNote`);
};

// The allow list is edited as text and saved on an explicit press, since a write per keystroke would replace the
// whole policy dozens of times for one word.
const allowDraft = useDraft(() => (policy.value === undefined ? undefined : allowListText(policy.value.allow)));
const allowValues = computed(() => allowListFrom(allowDraft.value));
const allowUnsaved = computed(() => policy.value !== undefined && !sameList(allowValues.value, policy.value.allow));
const allowProblem = computed(() => {
    const problem = allowListProblem(allowValues.value);
    if (problem === undefined) {
        return undefined;
    }
    return problem.kind === `tooMany`
        ? t(`sandbox.agentPrivacyShield.allowTooMany`, { max: PRIVACY_ALLOW_MAX, count: problem.count })
        : t(`sandbox.agentPrivacyShield.allowTooLong`, { max: ALLOW_VALUE_MAX, value: `${problem.value.slice(0, 40)}…` });
});
// The box is rewritten to what is saved (blanks and repeats gone), so it never shows a value twice that is stored once.
const saveAllow = (): void => {
    const allow = allowValues.value;
    allowDraft.value = allowListText(allow);
    write(`shield`, (current) => ({ ...current, allow }));
};

// Shown while the shield runs, or while it still has something to show: a dataset taught while it was off is the
// owner's to forget whatever the switch says, and a record outlives the switch that made it.
const showSources = computed(() => running.value || sources.value.length > 0);
const showActivity = computed(() => running.value || entries.value.length > 0);

// What the activity group draws per action: the word, its badge tone, and the glyph that leads the row.
const ACTIONS = computed(
    () =>
        ({
            masked: { label: t(`sandbox.agentPrivacyShield.masked`), variant: `success`, icon: `shield`, tone: `text-success` },
            watched: { label: t(`sandbox.agentPrivacyShield.watched`), variant: `info`, icon: `eye`, tone: `text-info` },
            passed: { label: t(`sandbox.agentPrivacyShield.passed`), variant: `neutral`, icon: `check`, tone: `text-subtle` },
            refused: { label: t(`sandbox.agentPrivacyShield.refused`), variant: `danger`, icon: `times`, tone: `text-danger` },
        }) satisfies Record<PrivacyLedgerAction, { label: string; variant: StatusVariant; icon: IconName; tone: string }>,
);

// The newest twenty: enough to see what the shield is doing, without the group outgrowing the controls above it.
const RECENT = 20;
const providerLabel = (id: string): string => providers.value.find((provider) => provider.id === id)?.label ?? id;
const activity = computed(() =>
    entries.value.slice(0, RECENT).map((entry, index) => ({
        entry,
        // Two requests can land in one millisecond; the position keeps their keys apart.
        key: `${entry.at}-${index}`,
        time: ledgerTime(entry.at),
        found: foundIn(entry),
        provider: providerLabel(entry.provider),
    })),
);

// Each taught dataset with its date read once; a date the daemon wrote unreadably is left off rather than drawn wrong.
const datasets = computed(() => sources.value.map((source) => ({ source, time: ledgerTime(source.at) })));

// The agent's own command for teaching a dataset, shown as written rather than translated.
const LEARN_COMMAND = `privacy learn <file> --column …`;
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup :label="t(`sandbox.agentPrivacyShield.title`)">
            <SkeletonRows v-if="isLoading" :rows="1" description />

            <RowNote v-else-if="error !== undefined" variant="block"
                ><Notice tone="danger">{{ error }}</Notice></RowNote
            >

            <template v-else>
                <Row
                    icon="eye-slash"
                    :title="t(`sandbox.agentPrivacyShield.shieldPersonalData`)"
                    :description="t(`sandbox.agentPrivacyShield.whatItKeeps`)"
                >
                    <template #control>
                        <SegmentedControl
                            :model-value="mode"
                            :options="MODES"
                            :class="{ [INERT]: !ready }"
                            @update:model-value="(next: PrivacyShieldMode) => write(`shield`, (current) => ({ ...current, mode: next }))"
                        />
                    </template>
                    <template #below>
                        <div class="flex flex-col gap-1.5 text-2xs text-muted">
                            <p>{{ modeNote }}</p>
                            <!-- What the shield has done so far, as plain counts; there is nothing to count while it is off. -->
                            <p v-if="running && status !== undefined" class="flex flex-wrap gap-x-4 gap-y-0.5">
                                <span>
                                    <span class="text-subtle">{{ t(`sandbox.agentPrivacyShield.tokensGiven`) }}</span>
                                    <span class="ml-1.5 tabular-nums text-content">{{ formatFixed(status.tokens, 0) }}</span>
                                </span>
                                <span>
                                    <span class="text-subtle">{{ t(`sandbox.agentPrivacyShield.learnedValues`) }}</span>
                                    <span class="ml-1.5 tabular-nums text-content">{{ formatFixed(status.known, 0) }}</span>
                                </span>
                            </p>
                        </div>
                    </template>
                </Row>

                <template v-if="running">
                    <Row icon="search" :title="t(`sandbox.agentPrivacyShield.lookFor`)" :description="t(`sandbox.agentPrivacyShield.lookForNote`)">
                        <template #below>
                            <!-- Checkboxes on a grid, not nine switch rows: the kinds are one choice made nine ways, read together. -->
                            <div class="grid grid-cols-1 gap-x-6 gap-y-2 @md:grid-cols-2 @3xl:grid-cols-3">
                                <label
                                    v-for="kind in PERSONAL_DATA_CLASSES"
                                    :key="kind"
                                    class="flex cursor-pointer items-center gap-2 text-xs text-content"
                                    :class="{ [INERT]: !ready }"
                                >
                                    <Checkbox
                                        :model-value="policy?.classes.includes(kind) ?? false"
                                        binary
                                        size="small"
                                        @update:model-value="(on: unknown) => write(`shield`, (current) => withClass(current, kind, on === true))"
                                    />
                                    <span>{{ KINDS[kind].label }}</span>
                                </label>
                            </div>
                        </template>
                    </Row>

                    <Row
                        icon="image"
                        :title="t(`sandbox.agentPrivacyShield.images`)"
                        :description="t(`sandbox.agentPrivacyShield.imagesDescription`)"
                    >
                        <template #control>
                            <SegmentedControl
                                :model-value="images"
                                :options="IMAGES"
                                :class="{ [INERT]: !ready }"
                                @update:model-value="(next: PrivacyImages) => write(`shield`, (current) => ({ ...current, images: next }))"
                            />
                        </template>
                        <template #below>
                            <div class="flex flex-col gap-1.5 text-2xs">
                                <p :class="images === `allow` ? `text-warning` : `text-muted`">{{ imagesNote }}</p>
                                <i18n-t
                                    v-if="ocrMissing"
                                    keypath="sandbox.agentPrivacyShield.noImageReader"
                                    tag="p"
                                    class="text-warning"
                                    scope="global"
                                >
                                    <template #command
                                        ><code class="ui-code whitespace-nowrap">{{ PACK_COMMAND }}</code></template
                                    >
                                </i18n-t>
                            </div>
                        </template>
                    </Row>

                    <Row icon="user" :title="t(`sandbox.agentPrivacyShield.names`)" :description="t(`sandbox.agentPrivacyShield.namesDescription`)">
                        <template #control>
                            <SegmentedControl
                                :model-value="names"
                                :options="NAMES"
                                :class="{ [INERT]: !ready }"
                                @update:model-value="(next: PrivacyNames) => write(`shield`, (current) => ({ ...current, names: next }))"
                            />
                        </template>
                        <template #below>
                            <div class="flex flex-col gap-1.5 text-2xs text-muted">
                                <p>{{ namesNote }}</p>
                                <p v-if="nameModelMissing" class="text-warning">{{ t(`sandbox.agentPrivacyShield.noNameModel`) }}</p>
                            </div>
                        </template>
                    </Row>

                    <Row
                        icon="check-circle"
                        :title="t(`sandbox.agentPrivacyShield.neverMasked`)"
                        :description="t(`sandbox.agentPrivacyShield.neverMaskedNote`)"
                    >
                        <template #below>
                            <div class="flex flex-col gap-2">
                                <textarea
                                    v-model="allowDraft"
                                    rows="4"
                                    :disabled="!ready"
                                    :aria-label="t(`sandbox.agentPrivacyShield.neverMasked`)"
                                    :placeholder="t(`sandbox.agentPrivacyShield.neverMaskedPlaceholder`)"
                                    :class="ui.input(`w-full resize-y font-mono`)"
                                ></textarea>
                                <div class="flex flex-wrap items-center justify-end gap-3">
                                    <span v-if="allowProblem !== undefined" class="mr-auto text-2xs text-danger">{{ allowProblem }}</span>
                                    <span v-else-if="allowUnsaved" class="mr-auto text-2xs text-warning">{{
                                        t(`sandbox.agentPrivacyShield.notSavedYet`)
                                    }}</span>
                                    <Button size="small" :disabled="!allowUnsaved || allowProblem !== undefined" @click="saveAllow">
                                        {{ t(`ui.action.save`) }}
                                    </Button>
                                </div>
                            </div>
                        </template>
                    </Row>
                </template>

                <RowNote v-if="saveNotice !== undefined && writtenFrom === `shield`" variant="block"><Notice :of="saveNotice" /></RowNote>
            </template>
        </RowGroup>

        <RowGroup v-if="running && status !== undefined" :label="t(`sandbox.agentPrivacyShield.trustedProviders`)">
            <RowNote>{{ t(`sandbox.agentPrivacyShield.trustedIntro`) }}</RowNote>

            <RowNote v-if="providers.length === 0" variant="empty">{{ t(`sandbox.agentPrivacyShield.noProviders`) }}</RowNote>

            <Row
                v-for="provider in providers"
                :key="provider.id"
                :icon="provider.local ? `desktop` : `cloud`"
                :title="provider.label"
                :description="providerNote(provider)"
            >
                <template #control>
                    <!-- A local model is trusted whatever the list says, so its switch is shown on and cannot be moved. -->
                    <ToggleSwitch
                        :model-value="policy !== undefined && providerTrusted(provider, policy)"
                        :disabled="provider.local || !ready"
                        :aria-label="t(`sandbox.agentPrivacyShield.trustProvider`, { label: provider.label })"
                        @update:model-value="(on: boolean) => write(`trusted`, (current) => withTrusted(current, provider.id, on))"
                    />
                </template>
            </Row>

            <RowNote v-if="saveNotice !== undefined && writtenFrom === `trusted`" variant="block"><Notice :of="saveNotice" /></RowNote>
        </RowGroup>

        <RowGroup v-if="showSources" :label="t(`sandbox.agentPrivacyShield.datasets`)">
            <SkeletonRows v-if="sourcesLoading" :rows="2" description />

            <RowNote v-else-if="sourcesError !== undefined" variant="block"
                ><Notice tone="danger">{{ sourcesError }}</Notice></RowNote
            >

            <template v-else>
                <RowNote v-if="sources.length === 0" variant="empty">{{ t(`sandbox.agentPrivacyShield.noDatasets`) }}</RowNote>

                <Row v-for="row in datasets" :key="row.source.source" icon="database">
                    <template #title>
                        <span class="block truncate font-mono text-xs" v-tooltip.top.overflow="row.source.source">{{ row.source.source }}</span>
                    </template>
                    <template #description>{{
                        t(`sandbox.agentPrivacyShield.valuesCount`, { count: formatFixed(row.source.count, 0) }, row.source.count)
                    }}</template>
                    <template v-if="row.time !== undefined" #meta>
                        <span v-tooltip.top="formatDateTime(row.time)">{{ formatDate(row.time) }}</span>
                    </template>
                    <template #control>
                        <Button size="small" severity="secondary" text @click="() => forget(row.source.source)">
                            {{ t(`sandbox.agentPrivacyShield.forget`) }}
                        </Button>
                    </template>
                </Row>
            </template>

            <!-- How a dataset gets here, since nothing on this page adds one: the agent teaches it from a file it can read. -->
            <RowNote>
                <i18n-t keypath="sandbox.agentPrivacyShield.datasetsNote" tag="span" scope="global">
                    <template #command
                        ><code class="ui-code whitespace-nowrap">{{ LEARN_COMMAND }}</code></template
                    >
                </i18n-t>
            </RowNote>

            <RowNote v-if="forgetNotice !== undefined" variant="block"><Notice :of="forgetNotice" /></RowNote>
        </RowGroup>

        <RowGroup v-if="showActivity" :label="t(`sandbox.agentPrivacyShield.activity`)">
            <SkeletonRows v-if="logLoading" :rows="3" description />

            <RowNote v-else-if="logError !== undefined" variant="block"
                ><Notice tone="danger">{{ logError }}</Notice></RowNote
            >

            <RowNote v-else-if="activity.length === 0" variant="empty">{{ t(`sandbox.agentPrivacyShield.noActivity`) }}</RowNote>

            <template v-else>
                <Row v-for="row in activity" :key="row.key">
                    <template #lead="{ iconClass }">
                        <Icon :name="ACTIONS[row.entry.action].icon" :class="[iconClass, ACTIONS[row.entry.action].tone]" />
                    </template>

                    <template #title>
                        <span class="flex min-w-0 items-baseline gap-2">
                            <span class="truncate">{{ row.provider }}</span>
                            <span class="shrink-0 text-2xs" :class="row.entry.trusted ? `text-subtle` : `text-warning`">
                                {{ row.entry.trusted ? t(`sandbox.agentPrivacyShield.trusted`) : t(`sandbox.agentPrivacyShield.untrusted`) }}
                            </span>
                        </span>
                    </template>

                    <template #description>
                        <span v-if="row.entry.action === `refused` && row.entry.detail !== undefined" class="text-danger">{{
                            row.entry.detail
                        }}</span>
                        <span v-else class="flex flex-wrap items-center gap-1.5">
                            <span>
                                {{
                                    row.found.total > 0
                                        ? t(`sandbox.agentPrivacyShield.found`, { count: row.found.total })
                                        : t(`sandbox.agentPrivacyShield.nothingFound`)
                                }}
                            </span>
                            <!-- Each kind with its count; the full name on hover, since the short word is what fits a row. -->
                            <span
                                v-for="part in row.found.parts"
                                :key="part.kind"
                                v-tooltip.top="KINDS[part.kind].label"
                                class="rounded bg-content/5 px-1.5 py-0.5 text-3xs text-subtle"
                            >
                                {{ KINDS[part.kind].short }} <span class="tabular-nums text-content">{{ part.count }}</span>
                            </span>
                            <span v-if="row.entry.images > 0" class="inline-flex items-center gap-1">
                                <Icon name="image" class="text-3xs" />
                                {{ t(`sandbox.agentPrivacyShield.imagesCount`, { count: row.entry.images }, row.entry.images) }}
                            </span>
                            <span v-if="row.entry.documents > 0" class="inline-flex items-center gap-1">
                                <Icon name="file" class="text-3xs" />
                                {{ t(`sandbox.agentPrivacyShield.documentsCount`, { count: row.entry.documents }, row.entry.documents) }}
                            </span>
                        </span>
                    </template>

                    <template #meta>
                        <StatusBadge :variant="ACTIONS[row.entry.action].variant" :label="ACTIONS[row.entry.action].label" size="xs" dot />
                        <span v-if="row.time !== undefined" class="shrink-0 text-2xs text-subtle" v-tooltip.top="formatDateTime(row.time)">
                            {{ timeAgo(row.time) }}
                        </span>
                    </template>
                </Row>

                <!-- The log keeps counts and kinds only, which is worth saying where a reader might look for the values. -->
                <RowNote>{{ t(`sandbox.agentPrivacyShield.activityNote`) }}</RowNote>
            </template>
        </RowGroup>
    </div>
</template>
