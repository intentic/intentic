<script setup lang="ts">
import { PERSONAL_DATA_CLASSES, type PersonalDataClass, type PrivacyShieldStatus } from "@intentic/sandbox-contract/schemas/privacy";
import { PRIVACY_LEAK_VALUE_MAX, type PrivacyLeakView } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import { Await, Button, Notice, Picker, Row, RowGroup, RowNote, SkeletonRows, ui } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import PrivacyHardenRun from "./PrivacyHardenRun.vue";
import PrivacyLeakRow from "./PrivacyLeakRow.vue";
import PrivacyProposalCard from "./PrivacyProposalCard.vue";
import { shortKindNames } from "../../../models/sandbox/privacyKinds";
import { usePrivacyLeaks } from "../../../models/sandbox/usePrivacyLeaks";
import { shieldRefusal } from "../../../models/sandbox/usePrivacyShield";

// Personal data that reached an untrusted provider as it was (schemas/privacy-leaks.ts): reported here or from a chat,
// or suspected by a scan run on this machine. Reporting or confirming one masks its exact value from then on; the
// hardening session the Harden press starts is what teaches the shield values like it, as proposals applied here. A
// dismissed leak is kept, so a scan does not suggest it again, and folded away behind its count.

const t = useT();

const { status, kinds } = defineProps<{
    status: PrivacyShieldStatus;
    /** Each kind's full name, as the page's checkboxes say it. */
    kinds: Readonly<Record<PersonalDataClass, string>>;
}>();

const {
    leaks,
    loaded,
    report,
    reporting,
    reportError,
    resetReport,
    judge,
    judging,
    judgeError,
    scan,
    scanning,
    scanned,
    scanError,
    applyProposal,
    dismissProposal,
    deciding,
    applyError,
    dismissError,
    noteSession,
    sessionError,
} = usePrivacyLeaks();

const SHORT = computed(shortKindNames);
const KIND_OPTIONS = computed(() => PERSONAL_DATA_CLASSES.map((kind) => ({ value: kind, label: kinds[kind] })));

const all = computed<readonly PrivacyLeakView[]>(() => leaks.value?.leaks ?? []);
const standing = computed(() => all.value.filter((leak) => leak.state !== `dismissed`));
const dismissed = computed(() => all.value.filter((leak) => leak.state === `dismissed`));
const showDismissed = ref(false);
const confirmedCount = computed(() => all.value.filter((leak) => leak.state === `confirmed`).length);
const suspectedCount = computed(() => all.value.filter((leak) => leak.state === `suspected`).length);

// Reporting: the value as it was sent and what it is; said done in place, and the field cleared for the next.
const value = ref(``);
const kind = ref<PersonalDataClass>(`person-name`);
const reported = ref(false);
const reportable = computed(() => value.value.trim().length >= 2 && !reporting.value);
const send = async (): Promise<void> => {
    reported.value = false;
    if (!reportable.value) {
        return;
    }
    if ((await report({ value: value.value.trim(), class: kind.value })) !== undefined) {
        value.value = ``;
        reported.value = true;
    }
};
const typed = (): void => {
    reported.value = false;
    resetReport();
};

const scanLine = computed(() => {
    const result = scanned.value;
    return result === undefined
        ? undefined
        : t(`sandbox.agentPrivacyShield.leaks.scan.result`, {
              conversations: t(
                  `sandbox.agentPrivacyShield.leaks.scan.conversations`,
                  { count: formatFixed(result.conversations, 0) },
                  result.conversations,
              ),
              suspected: t(`sandbox.agentPrivacyShield.leaks.scan.suspected`, { count: formatFixed(result.suspected, 0) }, result.suspected),
          });
});

const reportNotice = computed(() =>
    shieldRefusal(reportError.value, t(`sandbox.agentPrivacyShield.leaks.report.notYours`), t(`sandbox.agentPrivacyShield.leaks.report.failed`)),
);
const scanNotice = computed(() =>
    shieldRefusal(scanError.value, t(`sandbox.agentPrivacyShield.leaks.scan.notYours`), t(`sandbox.agentPrivacyShield.leaks.scan.failed`)),
);
const judgeNotice = computed(() =>
    shieldRefusal(judgeError.value, t(`sandbox.agentPrivacyShield.leaks.judgeNotYours`), t(`sandbox.agentPrivacyShield.leaks.judgeFailed`)),
);
// Said on the card it was refused for, not under every card.
const proposalNotice = (id: string) => {
    const applied = applyError.value;
    if (applied?.id === id) {
        return shieldRefusal(
            applied.error,
            t(`sandbox.agentPrivacyShield.leaks.proposal.applyNotYours`),
            t(`sandbox.agentPrivacyShield.leaks.proposal.applyFailed`),
        );
    }
    const dismissedOne = dismissError.value;
    return dismissedOne?.id === id
        ? shieldRefusal(
              dismissedOne.error,
              t(`sandbox.agentPrivacyShield.leaks.proposal.dismissNotYours`),
              t(`sandbox.agentPrivacyShield.leaks.proposal.dismissFailed`),
          )
        : undefined;
};
</script>

<template>
    <Await :of="loaded" imprint="sandbox.agent.privacy-leaks">
        <template #fallback>
            <RowGroup :label="t(`sandbox.agentPrivacyShield.leaks.title`)"><SkeletonRows :rows="3" description /></RowGroup>
        </template>
        <template #failed="{ error: unread }">
            <RowGroup :label="t(`sandbox.agentPrivacyShield.leaks.title`)">
                <RowNote variant="block"
                    ><Notice tone="danger">{{ unread }}</Notice></RowNote
                >
            </RowGroup>
        </template>
        <RowGroup data-setting="privacy-shield-leaks" :label="t(`sandbox.agentPrivacyShield.leaks.title`)">
            <RowNote>{{ t(`sandbox.agentPrivacyShield.leaks.intro`) }}</RowNote>

            <Row
                icon="shield"
                :title="t(`sandbox.agentPrivacyShield.leaks.report.title`)"
                :description="t(`sandbox.agentPrivacyShield.leaks.report.description`)"
            >
                <template #below>
                    <div class="flex flex-col gap-1.5">
                        <form class="flex flex-wrap items-center gap-2" @submit.prevent="send">
                            <input
                                v-model="value"
                                type="text"
                                autocomplete="off"
                                spellcheck="false"
                                :maxlength="PRIVACY_LEAK_VALUE_MAX"
                                :aria-label="t(`sandbox.agentPrivacyShield.leaks.report.field`)"
                                :placeholder="t(`sandbox.agentPrivacyShield.leaks.report.placeholder`)"
                                :class="ui.input({ size: `sm` }, `min-w-48 flex-1 font-mono`)"
                                @input="typed"
                            />
                            <Picker
                                v-model="kind"
                                :options="KIND_OPTIONS"
                                variant="ghost"
                                :aria-label="t(`sandbox.agentPrivacyShield.leaks.report.kind`)"
                                :header="t(`sandbox.agentPrivacyShield.leaks.report.kind`)"
                            />
                            <Button size="small" tier="boring" type="submit" :disabled="!reportable">{{
                                t(`sandbox.agentPrivacyShield.leaks.report.submit`)
                            }}</Button>
                        </form>
                        <p v-if="reported" aria-live="polite" class="text-2xs text-success">
                            {{ t(`sandbox.agentPrivacyShield.leaks.report.done`) }}
                        </p>
                        <Notice v-if="reportNotice !== undefined" :of="reportNotice" />
                    </div>
                </template>
            </Row>

            <Row
                icon="search"
                :title="t(`sandbox.agentPrivacyShield.leaks.scan.title`)"
                :description="t(`sandbox.agentPrivacyShield.leaks.scan.description`)"
            >
                <template #control>
                    <Button size="small" tier="boring" :disabled="scanning" @click="scan">{{
                        t(`sandbox.agentPrivacyShield.leaks.scan.run`)
                    }}</Button>
                </template>
                <template v-if="scanLine !== undefined || scanNotice !== undefined" #below>
                    <p v-if="scanLine !== undefined" aria-live="polite" class="text-2xs text-muted">{{ scanLine }}</p>
                    <Notice v-if="scanNotice !== undefined" :of="scanNotice" />
                </template>
            </Row>

            <PrivacyHardenRun
                :confirmed="confirmedCount"
                :suspected="suspectedCount"
                :status="status"
                :session="leaks?.session"
                @started="noteSession"
            />
            <RowNote v-if="sessionError !== null" variant="block"
                ><Notice tone="warning">{{ t(`sandbox.agentPrivacyShield.leaks.harden.notNoted`) }}</Notice></RowNote
            >

            <PrivacyProposalCard
                v-for="proposal in leaks?.proposals ?? []"
                :key="proposal.id"
                :proposal="proposal"
                :words="leaks?.words ?? {}"
                :kinds="SHORT"
                :busy="deciding === proposal.id"
                :notice="proposalNotice(proposal.id)"
                @apply="applyProposal(proposal.id)"
                @dismiss="dismissProposal(proposal.id)"
            />

            <RowNote v-if="all.length === 0" variant="empty">{{ t(`sandbox.agentPrivacyShield.leaks.empty`) }}</RowNote>

            <PrivacyLeakRow
                v-for="leak in standing"
                :key="leak.id"
                :leak="leak"
                :revealed="leaks?.revealed ?? false"
                :kinds="SHORT"
                :busy="judging === leak.id"
                @judge="(state) => judge(leak.id, state)"
            />

            <template v-if="dismissed.length > 0">
                <RowNote
                    variant="action"
                    :icon="showDismissed ? `chevron-up` : `chevron-down`"
                    :label="
                        showDismissed
                            ? t(`sandbox.agentPrivacyShield.leaks.hideDismissed`)
                            : t(`sandbox.agentPrivacyShield.leaks.showDismissed`, { count: formatFixed(dismissed.length, 0) })
                    "
                    @click="showDismissed = !showDismissed"
                />
                <template v-if="showDismissed">
                    <PrivacyLeakRow
                        v-for="leak in dismissed"
                        :key="leak.id"
                        :leak="leak"
                        :revealed="leaks?.revealed ?? false"
                        :kinds="SHORT"
                        :busy="judging === leak.id"
                        @judge="(state) => judge(leak.id, state)"
                    />
                </template>
            </template>

            <RowNote v-if="judgeNotice !== undefined" variant="block"><Notice :of="judgeNotice" /></RowNote>
        </RowGroup>
    </Await>
</template>
