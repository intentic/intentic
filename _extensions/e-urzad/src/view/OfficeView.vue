<!-- One connected office card: EZD RP cases and tasks, or e-Doręczenia deliveries and proofs, as last saved, with a live refresh, a connection test and the office acts the agent took. -->
<script setup lang="ts">
import { Button, formatDate, formatDateTime, Notice, noticeOf, Page, PageHeader, Row, RowGroup, StatusBadge, ui } from "@intentic/extension-ui";
import { computed, onMounted } from "vue";
import { t } from "../i18n.js";
import { deliveryTone, instant, type OfficeService } from "./facts.js";
import { useOffice } from "./useOffice.js";

const { account, service } = defineProps<{ account: string; service: OfficeService }>();

const describeTest = (detail: Readonly<Record<string, string | number>>): string =>
    service === `ezd-rp` ? t(`testedEzd`, { user: String(detail[`user`] ?? ``) }) : t(`testedEd`, { mailbox: String(detail[`mailbox`] ?? ``), environment: String(detail[`environment`] ?? ``) });

const { snapshot, error, tested, load, refresh, test } = useOffice(
    () => account,
    () => service,
    describeTest,
);
onMounted(() => {
    void load();
});

const when = (value: string | undefined): string => {
    const at = instant(value);
    return at === undefined ? (value ?? ``) : formatDateTime(at);
};

// A deadline is a day, not a moment: shown as a date so a midnight in UTC does not read as the evening before.
const day = (value: string | undefined): string => {
    const at = instant(value);
    return at === undefined ? (value ?? ``) : formatDate(at);
};

const title = computed(() => `${service === `ezd-rp` ? `EZD RP` : `e-Doręczenia`} · ${account}`);
const synced = computed(() => (snapshot.value?.syncedAt === undefined ? t(`neverSynced`) : t(`syncedAt`, { at: when(snapshot.value.syncedAt) })));
const cases = computed(() => snapshot.value?.cases ?? []);
const tasks = computed(() => snapshot.value?.tasks ?? []);
const deliveries = computed(() => snapshot.value?.deliveries ?? []);
const proofs = computed(() => snapshot.value?.proofs ?? []);
const actions = computed(() => (snapshot.value?.actions ?? []).slice(0, 20));

const caseLine = (row: (typeof cases.value)[number]): string =>
    [row.sign, row.jrwa === undefined ? undefined : t(`jrwa`, { symbol: row.jrwa }), row.deadline === undefined ? undefined : t(`deadline`, { at: day(row.deadline) })].filter((part) => part !== undefined).join(` · `);
const taskLine = (row: (typeof tasks.value)[number]): string =>
    [row.caseSign ?? row.registryNumber, t(`received`, { at: when(row.received) })].filter((part) => part !== undefined).join(` · `);
const deliveryLine = (row: (typeof deliveries.value)[number]): string =>
    [row.from, row.received === undefined ? undefined : t(`received`, { at: when(row.received) }), row.daysToReceive === undefined ? undefined : t(`daysLeft`, { days: row.daysToReceive })]
        .filter((part) => part !== undefined && part !== ``)
        .join(` · `);
const deliveryLabel = (row: (typeof deliveries.value)[number]): string => {
    if (row.kind === `Stub`) {
        return t(`waitingNotice`);
    }
    return row.opened ? (row.saved === undefined ? t(`opened`) : t(`openedSaved`)) : t(`notOpened`);
};
</script>

<template>
    <Page width="wide">
        <div class="flex flex-col gap-4">
            <PageHeader :title="title" :description="synced">
                <template #actions>
                    <Button :label="t(`test`)" icon="check-circle" tier="boring" @click="test" />
                    <Button :label="t(`refresh`)" icon="refresh" @click="refresh" />
                </template>
            </PageHeader>

            <Notice v-if="error" :of="noticeOf(error)" />
            <Notice v-if="tested" :of="{ tone: `success`, title: t(`connected`), detail: tested }" />
            <p class="text-xs text-muted">{{ service === `ezd-rp` ? t(`ezdNote`) : t(`edNote`) }}</p>

            <template v-if="service === `ezd-rp`">
                <section>
                    <h3 :class="ui.sectionLabel(`mb-2 px-1`)">{{ t(`cases`) }}</h3>
                    <p v-if="cases.length === 0" class="px-1 text-sm text-muted">{{ t(`noCases`) }}</p>
                    <RowGroup v-else>
                        <Row v-for="row in cases" :key="row.id" icon="folder" :title="row.title" :description="caseLine(row)">
                            <template #meta><StatusBadge variant="neutral" :label="row.status" size="xs" /></template>
                        </Row>
                    </RowGroup>
                </section>
                <section>
                    <h3 :class="ui.sectionLabel(`mb-2 px-1`)">{{ t(`tasks`) }}</h3>
                    <p v-if="tasks.length === 0" class="px-1 text-sm text-muted">{{ t(`noTasks`) }}</p>
                    <RowGroup v-else>
                        <Row v-for="row in tasks" :key="row.id" icon="list-check" :title="row.documentTitle" :description="taskLine(row)">
                            <template #meta><StatusBadge variant="info" :label="row.status" size="xs" /></template>
                        </Row>
                    </RowGroup>
                </section>
            </template>

            <template v-else>
                <section>
                    <h3 :class="ui.sectionLabel(`mb-2 px-1`)">{{ t(`deliveries`) }}</h3>
                    <p v-if="deliveries.length === 0" class="px-1 text-sm text-muted">{{ t(`noDeliveries`) }}</p>
                    <RowGroup v-else>
                        <Row v-for="row in deliveries" :key="row.id" icon="envelope" :title="row.subject || row.id" :description="deliveryLine(row)">
                            <template #meta>
                                <StatusBadge :variant="deliveryTone(row)" :label="deliveryLabel(row)" size="xs" />
                                <StatusBadge v-if="row.status" variant="neutral" :label="row.status" size="xs" />
                            </template>
                        </Row>
                    </RowGroup>
                </section>
                <section>
                    <h3 :class="ui.sectionLabel(`mb-2 px-1`)">{{ t(`proofs`) }}</h3>
                    <p class="mb-2 px-1 text-xs text-muted">{{ t(`proofNote`) }}</p>
                    <p v-if="proofs.length === 0" class="px-1 text-sm text-muted">{{ t(`noProofs`) }}</p>
                    <RowGroup v-else>
                        <Row v-for="proof in proofs" :key="proof.evidenceId" icon="shield" :title="t(`proofTitle`, { type: proof.type, message: proof.messageId })" :description="proof.path">
                            <template v-if="proof.eventDate" #meta><span class="text-2xs text-subtle">{{ when(proof.eventDate) }}</span></template>
                        </Row>
                    </RowGroup>
                </section>
            </template>

            <section v-if="actions.length > 0">
                <h3 :class="ui.sectionLabel(`mb-2 px-1`)">{{ t(`actions`) }}</h3>
                <RowGroup>
                    <Row v-for="action in actions" :key="`${action.at}-${action.key}`" icon="send" :title="action.outcome" :description="`${action.key} · ${when(action.at)}`" />
                </RowGroup>
            </section>
        </div>
    </Page>
</template>
