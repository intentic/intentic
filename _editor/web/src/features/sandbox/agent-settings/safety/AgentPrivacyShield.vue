<script setup lang="ts">
import {
    PERSONAL_DATA_CLASSES,
    type PersonalDataClass,
    type PrivacyImages,
    type PrivacyNames,
    type PrivacyProvider,
    type PrivacyShieldMode,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract";
import {
    Button,
    formatDate,
    formatDateTime,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    SegmentedControl,
    SkeletonRows,
    SkeletonSnapshot,
    vSkeletonSource,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import Checkbox from "primevue/checkbox";
import { computed, ref } from "vue";
import { SandboxHttpError } from "../../../../client/sandbox/sandboxHttpError";
import { allowAdding, ledgerTime, withClass } from "./privacyShield";
import PrivacyNameDictionary from "./PrivacyNameDictionary.vue";
import PrivacyNeverMasked from "./PrivacyNeverMasked.vue";
import PrivacyShieldActivity from "./PrivacyShieldActivity.vue";
import PrivacyTrustedProviders from "./PrivacyTrustedProviders.vue";
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

// An image always goes as an image: masked, with what the local reader finds painted over, or as it is.
const IMAGES = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.mask`), value: `mask` as const },
    { label: t(`sandbox.agentPrivacyShield.allow`), value: `allow` as const },
]);
const images = computed<PrivacyImages>(() => policy.value?.images ?? `mask`);
const imagesNote = computed(
    () =>
        ({
            mask: t(`sandbox.agentPrivacyShield.maskNote`),
            allow: t(`sandbox.agentPrivacyShield.allowNote`),
        })[images.value],
);
// Masking without the reader installed holds every image back, since none can be checked; said, or "Mask" claims what
// the daemon cannot do yet.
const ocrMissing = computed(() => images.value === `mask` && status.value?.readers.ocr === false);

const NAMES = computed(() => [
    { label: t(`sandbox.agentPrivacyShield.dictionary`), value: `dictionary` as const },
    { label: t(`sandbox.agentPrivacyShield.model`), value: `model` as const },
]);
const names = computed<PrivacyNames>(() => policy.value?.names ?? `dictionary`);
const namesNote = computed(() =>
    names.value === `model` ? t(`sandbox.agentPrivacyShield.modelNote`) : t(`sandbox.agentPrivacyShield.dictionaryNote`),
);
const nameModelMissing = computed(() => names.value === `model` && status.value?.readers.model === false);

// Each kind's full name, for its checkbox.
const KINDS = computed(
    () =>
        ({
            "person-name": t(`sandbox.agentPrivacyShield.classes.personName`),
            "national-id": t(`sandbox.agentPrivacyShield.classes.nationalId`),
            "tax-id": t(`sandbox.agentPrivacyShield.classes.taxId`),
            "identity-document": t(`sandbox.agentPrivacyShield.classes.identityDocument`),
            "bank-account": t(`sandbox.agentPrivacyShield.classes.bankAccount`),
            "payment-card": t(`sandbox.agentPrivacyShield.classes.paymentCard`),
            email: t(`sandbox.agentPrivacyShield.classes.email`),
            phone: t(`sandbox.agentPrivacyShield.classes.phone`),
            address: t(`sandbox.agentPrivacyShield.classes.address`),
        }) satisfies Record<PersonalDataClass, string>,
);

// Which group sent the last write, so a refusal is said in that group and not one a scroll away from the press.
type WriteSource = `shield` | `trusted` | `activity`;
const writtenFrom = ref<WriteSource>(`shield`);
const write = (from: WriteSource, change: (current: PrivacyShieldPolicy) => PrivacyShieldPolicy): void => {
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

// A value the activity showed being masked, pressed as one to leave alone: added to what is saved, unless the shield
// already reads it as listed.
const neverMask = (value: string): void => {
    write(`activity`, (current) => {
        const added = allowAdding(current.allow, value);
        return added.kind === `added` ? { ...current, allow: added.allow } : current;
    });
};

// Shown while the shield runs, or while it still has something to show: a dataset taught while it was off is the
// owner's to forget whatever the switch says, and a record outlives the switch that made it.
const showSources = computed(() => running.value || sources.value.length > 0);
const showActivity = computed(() => running.value || entries.value.length > 0);

// Each taught dataset with its date read once; a date the daemon wrote unreadably is left off rather than drawn wrong.
const datasets = computed(() => sources.value.map((source) => ({ source, time: ledgerTime(source.at) })));

// The agent's own command for teaching a dataset, shown as written rather than translated.
const LEARN_COMMAND = `privacy learn <file> --column …`;
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Each group waits on its own read, so each stands in whole, drawn as it last looked in this sandbox: their
             rows sit straight in the group, so nothing smaller can hold the imprint. -->
        <SkeletonSnapshot v-if="isLoading" of="sandbox.agent.privacy-shield">
            <RowGroup :label="t(`sandbox.agentPrivacyShield.title`)"><SkeletonRows :rows="1" description /></RowGroup>
        </SkeletonSnapshot>
        <RowGroup v-else v-skeleton-source="`sandbox.agent.privacy-shield`" :label="t(`sandbox.agentPrivacyShield.title`)">
            <RowNote v-if="error !== undefined" variant="block"
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
                            <p v-if="modeNote">{{ modeNote }}</p>
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
                                    <span>{{ KINDS[kind] }}</span>
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
                        <template v-if="imagesNote || ocrMissing" #below>
                            <div class="flex flex-col gap-1.5 text-2xs">
                                <p v-if="imagesNote" :class="images === `allow` ? `text-warning` : `text-muted`">{{ imagesNote }}</p>
                                <p v-if="ocrMissing" class="text-warning">{{ t(`sandbox.agentPrivacyShield.noImageReader`) }}</p>
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
                        <template v-if="namesNote || nameModelMissing" #below>
                            <div class="flex flex-col gap-1.5 text-2xs text-muted">
                                <p v-if="namesNote">{{ namesNote }}</p>
                                <p v-if="nameModelMissing" class="text-warning">{{ t(`sandbox.agentPrivacyShield.noNameModel`) }}</p>
                            </div>
                        </template>
                    </Row>

                    <!-- The lists both ways of finding names read, the model's way included: what they hold, and a word checked. -->
                    <PrivacyNameDictionary />

                    <PrivacyNeverMasked
                        :allow="policy?.allow"
                        :ready="ready"
                        @write="(change) => write(`shield`, (current) => ({ ...current, allow: change(current.allow) }))"
                    />
                </template>

                <RowNote v-if="saveNotice !== undefined && writtenFrom === `shield`" variant="block"><Notice :of="saveNotice" /></RowNote>
            </template>
        </RowGroup>

        <PrivacyTrustedProviders
            v-if="running && status !== undefined"
            :providers="providers"
            :policy="policy"
            :ready="ready"
            :notice="writtenFrom === `trusted` ? saveNotice : undefined"
            @write="(change) => write(`trusted`, change)"
        />

        <!-- The note on how a dataset arrives is drawn under the outline too, as it is under the list. -->
        <SkeletonSnapshot v-if="showSources && sourcesLoading" of="sandbox.agent.privacy-datasets">
            <RowGroup :label="t(`sandbox.agentPrivacyShield.datasets`)">
                <SkeletonRows :rows="2" description />
                <RowNote>
                    <i18n-t keypath="sandbox.agentPrivacyShield.datasetsNote" tag="span" scope="global">
                        <template #command
                            ><code class="ui-code whitespace-nowrap">{{ LEARN_COMMAND }}</code></template
                        >
                    </i18n-t>
                </RowNote>
            </RowGroup>
        </SkeletonSnapshot>
        <RowGroup v-else-if="showSources" v-skeleton-source="`sandbox.agent.privacy-datasets`" :label="t(`sandbox.agentPrivacyShield.datasets`)">
            <RowNote v-if="sourcesError !== undefined" variant="block"
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
                        <Button size="small" tier="quiet" @click="() => forget(row.source.source)">
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

        <SkeletonSnapshot v-if="showActivity && logLoading" of="sandbox.agent.privacy-activity">
            <RowGroup :label="t(`sandbox.agentPrivacyShield.activity`)"><SkeletonRows :rows="3" description /></RowGroup>
        </SkeletonSnapshot>
        <PrivacyShieldActivity
            v-else-if="showActivity"
            v-skeleton-source="`sandbox.agent.privacy-activity`"
            :entries="entries"
            :providers="providers"
            :policy="policy"
            :ready="ready"
            :error="logError"
            :notice="writtenFrom === `activity` ? saveNotice : undefined"
            @never-mask="neverMask"
        />
    </div>
</template>
