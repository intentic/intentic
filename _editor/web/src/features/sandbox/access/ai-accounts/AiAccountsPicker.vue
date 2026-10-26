<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { TranslatorAccount } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { SegmentedControl, SkeletonRows } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { accountsOf } from "../../../../models/conversations/accounts/useChat-accounts";
import { accountsLoaded, translatorAccounts } from "../../../../models/providers/providerAccounts";
import { acpProviders, endpointProviders } from "../../../../models/providers/providerCatalog";
import ProviderLogo from "../../../../parts/providers/ProviderLogo.vue";
import type { AiAccountsDraft } from "../accessGrant";
import { type AccountlessKind, aiAccountRows } from "./aiAccountOptions";
import MultiPick from "../pick/MultiPick.vue";
import type { PickSection } from "../pick/multiPick";

// WHICH AI ACCOUNTS ONE PERSON'S CONVERSATIONS RUN ON: every one, or the ones picked here. The model accounts that pay
// for a turn, apart from the connections their agents work with (ReachPicker), since the two are narrowed for different
// reasons and narrowing one must never empty the other. Enforced by the sandbox where a turn's account is decided
// (the daemon's agent/run/decide/account-reach.ts): a turn they name on another account is refused, one left to the
// sandbox runs on one of theirs, and a conversation somebody else started on another account is moved onto theirs.

const t = useT();

const { accounts, disabled = false } = defineProps<{ accounts: AiAccountsDraft; disabled?: boolean }>();
const emit = defineEmits<{ change: [accounts: AiAccountsDraft] }>();

// The lists every account surface reads, loaded for the whole app whenever the daemon is reachable (loadAccountStatus):
// this picker reads them and asks for nothing of its own.

const NOTES = {
    endpoint: () => t(`sandbox.sandboxAccess.aiAccountsEndpoint`),
    agent: () => t(`sandbox.sandboxAccess.aiAccountsAgent`),
} satisfies Record<AccountlessKind, () => string>;

// The translator's subscriptions for a provider it routes; none for any other.
const routedOf = (id: AgentProvider): readonly TranslatorAccount[] => {
    const keyed = KeyedProviderSchema.safeParse(id);
    return keyed.success ? translatorAccounts.value[keyed.data] : [];
};

const rows = computed(() =>
    aiAccountRows(
        {
            providers: NATIVE_PROVIDERS.map((id) => ({
                id,
                label: providerLabel(id),
                native: accountsOf(id),
                routed: routedOf(id),
            })),
            endpoints: endpointProviders.value,
            agents: acpProviders.value,
        },
        (kind) => NOTES[kind](),
    ),
);
const sections = computed<PickSection[]>(() => (rows.value.entries.length === 0 ? [] : [{ key: `ai-accounts`, entries: rows.value.entries }]));

type Mode = `all` | `some`;
const mode = computed<Mode>(() => (accounts === `all` ? `all` : `some`));
// What each mode means rides on it as a hover card, rather than as lines under the control; the accounts with no
// allowance to spend are named on "Only these", the one place they matter.
const MODES = computed(() => [
    {
        value: `all` as const,
        label: t(`sandbox.sandboxAccess.reachAll`),
        icon: `check-circle` as const,
        title: { title: t(`sandbox.sandboxAccess.tipAiAllTitle`), note: t(`sandbox.sandboxAccess.tipAiAllNote`) },
    },
    {
        value: `some` as const,
        label: t(`sandbox.sandboxAccess.reachSome`),
        icon: `lock` as const,
        title: {
            title: t(`sandbox.sandboxAccess.tipPickedOnly`),
            note: t(`sandbox.sandboxAccess.tipAiSomeNote`),
            rows:
                rows.value.alwaysAvailable.length === 0
                    ? undefined
                    : [{ label: t(`sandbox.sandboxAccess.tipAlwaysAvailable`), value: rows.value.alwaysAvailable.join(`, `) }],
        },
    },
]);
// Narrowing starts from nothing ticked, as the connections' reach does: the owner names what they mean to hand over.
const pickMode = (next: Mode): void => emit(`change`, next === `all` ? `all` : []);
const picked = computed<readonly string[]>(() => (accounts === `all` ? [] : accounts));
</script>

<template>
    <div class="flex flex-col gap-3">
        <SegmentedControl :model-value="mode" :options="MODES" :class="{ 'pointer-events-none opacity-60': disabled }" @update:model-value="pickMode" />

        <template v-if="mode === `some`">
            <div v-if="!accountsLoaded && sections.length === 0" role="status" aria-busy="true"><SkeletonRows :rows="3" /></div>
            <p v-else-if="sections.length === 0" class="text-sm text-muted">{{ t(`sandbox.sandboxAccess.aiAccountsNoneConnected`) }}</p>
            <MultiPick
                v-else
                :sections="sections"
                :picked="picked"
                :search-label="t(`sandbox.sandboxAccess.aiAccountsSearch`)"
                :aria-label="t(`sandbox.sandboxAccess.aiAccountsSection`)"
                tally
                :disabled="disabled"
                @change="(values) => emit(`change`, values)"
            >
                <template #mark="{ value, size }">
                    <span class="flex shrink-0 items-center justify-center text-subtle" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${size}px` }">
                        <ProviderLogo v-if="rows.providerOf.has(value)" :provider="rows.providerOf.get(value) ?? ``" />
                    </span>
                </template>
            </MultiPick>
        </template>
    </div>
</template>
