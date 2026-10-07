import { isTrialProvider, KeyedProviderSchema, NATIVE_PROVIDERS, providerLabel, providerSpec } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { translatorAccounts } from "../../chat/accounts/providerAccounts";
import { endpointProviders, trialStatus } from "../../chat/accounts/providerCatalog";
import { accountsOf, subscriptionOnly } from "../../chat/accounts/useChat-accounts";
import { hasSignIn } from "../../chat/session/access";
import { accountFacts, accountState, formatReset, routedAccountFacts } from "../../chat/session/usageStatus";
import { type AccountReading, type ModelSource, type ModelSourceInput, modelSources } from "./modelSources";

// The live inputs to modelSources.ts, read off the same stores every picker reads: a provider's own accounts and its
// subscriptions as one source (Grok can hold both), then the endpoints the daemon publishes, the trial among them.

const accountReadings = (provider: string): AccountReading[] => {
    const native = subscriptionOnly(provider)
        ? []
        : accountsOf(provider).map((account) => ({ label: account.label, state: accountState(provider, accountFacts(account)) }));
    // Parsed rather than asserted: only a provider the translator keys has subscriptions to read.
    const keyed = KeyedProviderSchema.safeParse(provider);
    const routed = keyed.success && providerSpec(provider)?.auth.kind === `translator` ? (translatorAccounts.value[keyed.data] ?? []) : [];
    return [...native, ...routed.map((account) => ({ label: account.label, state: accountState(provider, routedAccountFacts(account)) }))];
};

const inputs = (): ModelSourceInput[] => [
    ...NATIVE_PROVIDERS.filter((provider) => hasSignIn(provider)).map((provider): ModelSourceInput => ({
        kind: `account`,
        provider,
        label: providerSpec(provider)?.accountLabel ?? providerLabel(provider),
        accounts: accountReadings(provider),
    })),
    ...endpointProviders.value.flatMap((endpoint): ModelSourceInput[] => {
        if (isTrialProvider(endpoint.id)) {
            // A trial the daemon lists but cannot offer today is not something this sandbox runs on.
            return trialStatus.value.available
                ? [{ kind: `trial`, provider: endpoint.id, label: endpoint.label, remaining: trialStatus.value.remaining }]
                : [];
        }
        return [{ kind: endpoint.kind === `localmodel` ? `local` : `endpoint`, provider: endpoint.id, label: endpoint.label }];
    }),
];

export const useModelSources = (): ComputedRef<readonly ModelSource[]> =>
    computed(() => modelSources(inputs(), (epochSeconds) => formatReset(epochSeconds)));
