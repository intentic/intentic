<script setup lang="ts">
import { endpointProvider, type PrivacyProvider, type PrivacyShieldPolicy, TRIAL_ENDPOINT_ID } from "@intentic/sandbox-contract";
import { Button, Notice, type NoticeModel, Row, RowGroup, RowNote, StatusBadge, type StatusVariant } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { type ProviderReceives, providerReceives, providerTrusted, withTrusted } from "./privacyShield";
import PrivacyProviderMark from "./PrivacyProviderMark.vue";

// Who may read personal data as it is: each provider by its own mark, what it is sent under the policy in force said
// beside the switch that changes it, and a line on why only where its case is not the plain one (a model on this
// machine, the free trial, a runtime the gateway can't sit in front of). The writes go through the page, which owns the policy
// and says a refusal beside the group that sent it.

const t = useT();

const { providers, policy, ready, notice } = defineProps<{
    providers: readonly PrivacyProvider[];
    policy: PrivacyShieldPolicy | undefined;
    ready: boolean;
    notice: NoticeModel | undefined;
}>();

const emit = defineEmits<{ write: [change: (current: PrivacyShieldPolicy) => PrivacyShieldPolicy] }>();

// The pill beside each switch: what the provider is sent right now, in the tone of how much of it leaves.
const RECEIVES = computed(
    () =>
        ({
            tokens: { label: t(`sandbox.agentPrivacyShield.receives.tokens`), variant: `success` },
            watched: { label: t(`sandbox.agentPrivacyShield.receives.watched`), variant: `info` },
            values: { label: t(`sandbox.agentPrivacyShield.receives.values`), variant: `warning` },
            refused: { label: t(`sandbox.agentPrivacyShield.receives.refused`), variant: `danger` },
            local: { label: t(`sandbox.agentPrivacyShield.receives.local`), variant: `neutral` },
        }) satisfies Record<ProviderReceives, { label: string; variant: StatusVariant }>,
);

// The free trial is reached through a tunnel on this machine, but every request goes on to Intentic's platform and the
// vendor behind it: never trusted by itself, so its row says where the data would go before anyone switches it on.
const TRIAL_PROVIDER = endpointProvider(TRIAL_ENDPOINT_ID);

// A line under the name only where the provider's case is not the plain one: the pill already says what it is sent,
// and the same sentence under every row is the repetition the list is for avoiding.
const noteFor = (provider: PrivacyProvider): string | undefined => {
    if (provider.local) {
        return t(`sandbox.agentPrivacyShield.localNote`);
    }
    if (provider.id === TRIAL_PROVIDER) {
        return t(`sandbox.agentPrivacyShield.trialNote`);
    }
    return provider.shieldable ? undefined : t(`sandbox.agentPrivacyShield.unshieldableNote`);
};

const rows = computed(() =>
    providers.map((provider) => {
        const receives: ProviderReceives = policy === undefined ? `values` : providerReceives(provider, policy);
        return { provider, receives, note: noteFor(provider), trusted: policy !== undefined && providerTrusted(provider, policy) };
    }),
);

// Grants made one conversation at a time, from each conversation's own strip above its composer: counted here so how far
// the shield has been opened is in view on the page that sets it, and taken back together in one press.
const conversationGrants = computed(() => policy?.conversations.length ?? 0);
</script>

<template>
    <RowGroup :label="t(`sandbox.agentPrivacyShield.trustedProviders`)">
        <RowNote>{{ t(`sandbox.agentPrivacyShield.trustedIntro`) }}</RowNote>

        <RowNote v-if="providers.length === 0" variant="empty">{{ t(`sandbox.agentPrivacyShield.noProviders`) }}</RowNote>

        <Row v-for="row in rows" :key="row.provider.id" lead="face" :title="row.provider.label" :description="row.note">
            <template #lead="{ mark }">
                <PrivacyProviderMark :provider="row.provider.id" :local="row.provider.local" :size="mark" />
            </template>
            <template #meta>
                <StatusBadge :variant="RECEIVES[row.receives].variant" :label="RECEIVES[row.receives].label" size="xs" dot />
            </template>
            <template #control>
                <!-- A local model is trusted whatever the list says, so its switch is shown on and cannot be moved. -->
                <ToggleSwitch
                    :model-value="row.trusted"
                    :disabled="row.provider.local || !ready"
                    :aria-label="t(`sandbox.agentPrivacyShield.trustProvider`, { label: row.provider.label })"
                    @update:model-value="(on: boolean) => emit(`write`, (current) => withTrusted(current, row.provider.id, on))"
                />
            </template>
        </Row>

        <RowNote v-if="conversationGrants > 0">
            <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="min-w-0 flex-1">{{
                    t(`sandbox.agentPrivacyShield.conversationGrants`, { count: conversationGrants }, conversationGrants)
                }}</span>
                <Button size="small" tier="quiet" :disabled="!ready" @click="emit(`write`, (current) => ({ ...current, conversations: [] }))">{{
                    t(`sandbox.agentPrivacyShield.takeBackAll`)
                }}</Button>
            </span>
        </RowNote>

        <RowNote v-if="notice !== undefined" variant="block"><Notice :of="notice" /></RowNote>
    </RowGroup>
</template>
