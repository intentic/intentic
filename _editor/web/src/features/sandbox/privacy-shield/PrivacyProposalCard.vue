<script setup lang="ts">
import type { PersonalDataClass, PrivacyNameListKind } from "@intentic/sandbox-contract/schemas/privacy";
import { leakWordKey, type PrivacyLeakWord, type PrivacyProposal } from "@intentic/sandbox-contract/schemas/privacy-leaks";
import { Button, formatDate, formatDateTime, Notice, type NoticeModel, Row } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { ledgerTime } from "./privacyShield";

// One hardening proposal waiting for the owner: what the session said it is for, what it measured when it proposed
// (against the confirmed leaks, and against recent conversations on this machine), and what applying adds: rules
// switched on, and words put on a name list. A word the session named by its leak is shown as the daemon resolved it.

const t = useT();

const { proposal, words, kinds, busy, notice } = defineProps<{
    proposal: PrivacyProposal;
    /** The proposals' leak words, by `leakWordKey`, as this reader may read them. */
    words: Readonly<Record<string, string>>;
    /** Each kind's short name, as the chip beside a value says it. */
    kinds: Readonly<Record<PersonalDataClass, string>>;
    busy: boolean;
    notice: NoticeModel | undefined;
}>();

const emit = defineEmits<{ apply: []; dismiss: [] }>();

const LIST_KINDS = computed(
    () =>
        ({
            "first-name": t(`sandbox.agentPrivacyShield.ownList.kinds.firstName`),
            surname: t(`sandbox.agentPrivacyShield.ownList.kinds.surname`),
            ambiguous: t(`sandbox.agentPrivacyShield.ownList.kinds.ambiguous`),
            title: t(`sandbox.agentPrivacyShield.ownList.kinds.title`),
            never: t(`sandbox.agentPrivacyShield.ownList.kinds.never`),
        }) satisfies Record<PrivacyNameListKind, string>,
);

const measured = computed(() => proposal.measured);
const caughtLine = computed(() => {
    const { after, total, before } = measured.value.leaks;
    return t(
        `sandbox.agentPrivacyShield.leaks.proposal.leaks`,
        { after: formatFixed(after, 0), total: formatFixed(total, 0), before: formatFixed(before, 0) },
        total,
    );
});
const addedLine = computed(() => {
    const { added } = measured.value.control;
    return added === 0
        ? t(`sandbox.agentPrivacyShield.leaks.proposal.addedNone`)
        : t(`sandbox.agentPrivacyShield.leaks.proposal.added`, { count: formatFixed(added, 0) }, added);
});

const rules = computed(() =>
    proposal.hardening.rules.map((rule) => ({
        rule,
        summary:
            rule.match === `pattern`
                ? rule.pattern
                : t(`sandbox.agentPrivacyShield.rule.termsCount`, { count: formatFixed(rule.terms.length, 0) }, rule.terms.length),
        masksAs: t(`sandbox.agentPrivacyShield.rule.masksAs`, { kind: kinds[rule.class] }),
    })),
);

// A word named by its leak reads as the daemon resolved it; where it could not, by which leak's which word.
const leakWord = (word: PrivacyLeakWord): string =>
    words[leakWordKey(word)] ?? t(`sandbox.agentPrivacyShield.leaks.proposal.leakWord`, { word: word.word + 1, leak: word.leak });
const lists = computed(() =>
    proposal.hardening.lists.map((list) => ({ list, words: [...list.words, ...list.fromLeaks.map(leakWord)].join(`, `) })),
);

const time = computed(() => ledgerTime(proposal.at));
</script>

<template>
    <Row icon="list-check" :title="proposal.title" :description="t(`sandbox.agentPrivacyShield.leaks.proposal.waiting`)">
        <template v-if="time !== undefined" #meta>
            <span v-tooltip.top="formatDateTime(time)">{{ formatDate(time) }}</span>
        </template>
        <template #control>
            <Button size="small" tier="quiet" :disabled="busy" @click="emit(`dismiss`)">{{ t(`sandbox.agentPrivacyShield.leaks.proposal.dismiss`) }}</Button>
            <Button size="small" tier="boring" :disabled="busy" @click="emit(`apply`)">{{
                t(`sandbox.agentPrivacyShield.leaks.proposal.apply`)
            }}</Button>
        </template>
        <template #below>
            <div class="flex flex-col gap-2 text-2xs">
                <p v-if="proposal.why !== ``" class="whitespace-pre-line text-muted">{{ proposal.why }}</p>

                <!-- What it measured when proposed: the leaks it catches, and what else it would mask, each sample as its outline. -->
                <div class="flex flex-col gap-1">
                    <p v-if="measured.leaks.total > 0" class="text-content">{{ caughtLine }}</p>
                    <p v-if="measured.leaks.missed.length > 0" class="text-muted">
                        {{ t(`sandbox.agentPrivacyShield.leaks.proposal.missed`, { ids: measured.leaks.missed.join(`, `) }) }}
                    </p>
                    <p :class="measured.control.added > 0 ? `text-content` : `text-muted`">{{ addedLine }}</p>
                    <ul v-if="measured.control.samples.length > 0" class="flex flex-wrap gap-1.5">
                        <li
                            v-for="(sample, index) in measured.control.samples"
                            :key="index"
                            v-tooltip.top="sample.value"
                            class="flex items-baseline gap-1 rounded bg-content/5 px-1.5 py-0.5"
                        >
                            <span class="font-mono text-content">{{ sample.outline }}</span>
                            <span class="text-3xs text-subtle">{{ kinds[sample.class] }}</span>
                            <span v-if="sample.label !== undefined" class="text-3xs text-subtle">{{
                                t(`sandbox.agentPrivacyShield.leaks.origin.label`, { label: sample.label })
                            }}</span>
                        </li>
                    </ul>
                </div>

                <!-- What applying adds, as the rules and lists above it on the page would show it. -->
                <ul v-if="rules.length > 0 || lists.length > 0" class="flex flex-col divide-y divide-line-subtle">
                    <li v-for="(row, index) in rules" :key="`rule-${index}`" class="flex min-w-0 flex-col py-1">
                        <span class="flex items-baseline gap-1.5">
                            <span class="truncate text-xs text-content">{{ row.rule.title }}</span>
                            <span class="shrink-0 rounded bg-content/5 px-1.5 py-0.5 text-3xs text-subtle">{{
                                row.rule.match === `pattern`
                                    ? t(`sandbox.agentPrivacyShield.rule.matchPattern`)
                                    : t(`sandbox.agentPrivacyShield.rule.matchTerms`)
                            }}</span>
                        </span>
                        <span class="flex min-w-0 items-baseline gap-1.5 text-muted">
                            <span class="truncate" :class="{ 'font-mono': row.rule.match === `pattern` }">{{ row.summary }}</span>
                            <span class="shrink-0">· {{ row.masksAs }}</span>
                        </span>
                    </li>
                    <li v-for="(row, index) in lists" :key="`list-${index}`" class="flex min-w-0 flex-col py-1">
                        <span class="flex items-baseline gap-1.5">
                            <span class="truncate text-xs text-content">{{ row.list.title }}</span>
                            <span class="shrink-0 rounded bg-content/5 px-1.5 py-0.5 text-3xs text-subtle">{{ LIST_KINDS[row.list.kind] }}</span>
                        </span>
                        <span class="break-words text-muted">{{ row.words }}</span>
                    </li>
                </ul>

                <div v-if="measured.problems.length > 0" class="flex flex-col gap-0.5 text-danger">
                    <p>{{ t(`sandbox.agentPrivacyShield.leaks.proposal.problems`) }}</p>
                    <p v-for="(problem, index) in measured.problems" :key="index">{{ problem }}</p>
                </div>

                <Notice v-if="notice !== undefined" :of="notice" />
            </div>
        </template>
    </Row>
</template>
