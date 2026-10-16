<script setup lang="ts">
import {
    PRIVACY_PREVIEW_MAX,
    type PersonalDataClass,
    type PrivacyPreviewSpan,
    type PrivacyShieldPolicy,
} from "@intentic/sandbox-contract/schemas/privacy";
import { Notice, Row, ui } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { rulesOf } from "./privacyOwn";
import { usePrivacyPreview } from "../../../models/sandbox/usePrivacyShield";

// The shield tried on a text the owner pastes: what it would mask with everything above as saved (the detectors, the
// name lists, their own lists and rules, the values the vault knows), each find lit with its kind and what found it.
// Read on this machine and kept nowhere, so a real sample is fine to try; nothing is given a token.

const t = useT();

const { policy } = defineProps<{ policy: PrivacyShieldPolicy | undefined }>();

const text = ref(``);
const { preview, isFetching, error } = usePrivacyPreview(text);

const SHORT = computed(
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

const foundBy = (span: PrivacyPreviewSpan): string => {
    switch (span.by) {
        case `rule`:
            return t(`sandbox.agentPrivacyShield.try.by.rule`, {
                rule: rulesOf(policy).find((rule) => rule.id === span.rule)?.title ?? span.rule ?? ``,
            });
        case `learned`:
            return t(`sandbox.agentPrivacyShield.try.by.learned`);
        case `model`:
            return t(`sandbox.agentPrivacyShield.try.by.model`);
        case `detector`:
            return t(`sandbox.agentPrivacyShield.try.by.detector`);
    }
};

interface Part {
    readonly text: string;
    readonly kind?: string;
    readonly why?: string;
}

// The text the answer is about, cut where each find starts and ends.
const parts = computed<readonly Part[]>(() => {
    const answer = preview.value;
    if (answer === undefined) {
        return [];
    }
    const out: Part[] = [];
    let last = 0;
    for (const span of answer.spans) {
        if (span.start > last) {
            out.push({ text: answer.text.slice(last, span.start) });
        }
        out.push({
            text: answer.text.slice(span.start, span.end),
            kind: SHORT.value[span.class],
            why: `${SHORT.value[span.class]} · ${foundBy(span)}`,
        });
        last = span.end;
    }
    return last < answer.text.length ? [...out, { text: answer.text.slice(last) }] : out;
});

const count = computed(() => preview.value?.spans.length ?? 0);
</script>

<template>
    <Row indent icon="eye" :title="t(`sandbox.agentPrivacyShield.try.title`)" :description="t(`sandbox.agentPrivacyShield.try.description`)">
        <template #below>
            <div class="flex flex-col gap-2">
                <textarea
                    v-model="text"
                    rows="3"
                    spellcheck="false"
                    :maxlength="PRIVACY_PREVIEW_MAX"
                    :aria-label="t(`sandbox.agentPrivacyShield.try.field`)"
                    :placeholder="t(`sandbox.agentPrivacyShield.try.placeholder`)"
                    :class="ui.input({}, `w-full resize-y`)"
                ></textarea>

                <Notice v-if="error !== undefined" tone="danger">{{ error }}</Notice>

                <div v-else-if="preview !== undefined" class="flex flex-col gap-1.5" :class="{ 'opacity-60': isFetching }">
                    <!-- The text as tried, each find lit and named; which source found it is on hover. -->
                    <p class="whitespace-pre-wrap break-words rounded bg-content/5 px-2.5 py-2 text-xs leading-relaxed text-content">
                        <template v-for="(part, index) in parts" :key="index">
                            <span v-if="part.kind !== undefined" v-tooltip.top="part.why" class="whitespace-nowrap"
                                ><mark class="rounded-sm bg-warning-500/25 px-0.5 text-inherit">{{ part.text }}</mark
                                ><sup class="ml-0.5 text-3xs text-subtle">{{ part.kind }}</sup></span
                            >
                            <template v-else>{{ part.text }}</template>
                        </template>
                    </p>
                    <p aria-live="polite" class="text-2xs" :class="count > 0 ? `text-muted` : `text-subtle`">
                        {{
                            count > 0
                                ? t(`sandbox.agentPrivacyShield.try.found`, { count: formatFixed(count, 0) }, count)
                                : t(`sandbox.agentPrivacyShield.try.nothing`)
                        }}
                    </p>
                </div>
            </div>
        </template>
    </Row>
</template>
