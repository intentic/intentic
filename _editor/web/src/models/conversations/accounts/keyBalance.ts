import type { KeyBalance } from "@intentic/sandbox-contract/contracts/endpoints.contract";
import { endpointIdOf, isTrialProvider } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { formatAmount } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../../lib/queryKeys";
import { endpointProviders, providerDisplayLabel } from "../../providers/providerCatalog";
import { formatAge, formatReset } from "../../providers/usageStatus";

// What is left to spend on the API key a chat runs on: a key's counterpart of a sign-in's plan limits. The daemon asks
// the vendor with the key itself (endpoints/key-balance.ts), and only some vendors answer (Moonshot, DeepSeek, an
// OpenRouter key with a cap), so absent is the ordinary answer, never a zero.

// Below this much of a capped key's limit, or this many dollars of an account's credit, the figure turns to a warning.
const LOW_SHARE = 0.1;
const LOW_AMOUNT = 1;

// Only a remote server can be a vendor's key: local weights and the free trial have no balance of this kind.
const readsBalance = (provider: AgentProvider): boolean =>
    !isTrialProvider(provider) && endpointProviders.value.some((endpoint) => endpoint.id === provider && endpoint.kind === `endpoint`);

// Whether the balance is near the point the vendor refuses the next request.
export const balanceLow = (balance: KeyBalance): boolean =>
    balance.limit !== undefined && balance.limit > 0 ? balance.remaining / balance.limit <= LOW_SHARE : balance.remaining <= LOW_AMOUNT;

// The chip's words: what is left, and of how much where the key has a cap.
export const balanceLabel = (balance: KeyBalance): string => {
    const amount = formatAmount(balance.remaining, balance.currency);
    return balance.limit === undefined
        ? t(`chat.keyBalance.left`, { amount })
        : t(`chat.keyBalance.leftOf`, { amount, limit: formatAmount(balance.limit, balance.currency) });
};

// The hover card under the chip: whose figure it is, the cap and its reset where there is one, and how old the reading is.
export const balanceTip = (provider: AgentProvider, balance: KeyBalance, now: number = Date.now()) => ({
    title: t(`chat.keyBalance.title`, { key: providerDisplayLabel(provider) }),
    tone: balanceLow(balance) ? (`warning` as const) : undefined,
    rows: [
        { label: t(`chat.keyBalance.remaining`), value: formatAmount(balance.remaining, balance.currency) },
        ...(balance.limit === undefined ? [] : [{ label: t(`chat.keyBalance.limit`), value: formatAmount(balance.limit, balance.currency) }]),
        ...(balance.resetsAt === undefined ? [] : [{ label: t(`chat.keyBalance.resets`), value: formatReset(balance.resetsAt, now) }]),
        { label: t(`chat.keyBalance.measured`), value: formatAge(balance.measuredAt, now) },
    ],
    note: t(`chat.keyBalance.note`),
});

/** The balance on a key provider, read on mount and again whenever `refetch` is pressed (the composer, as a turn ends). */
export const useKeyBalance = (provider: MaybeRefOrGetter<AgentProvider>) => {
    const id = computed(() => endpointIdOf(toValue(provider)));
    const { query } = useSandboxQuery({
        queryKey: computed(() => rpcKey(`endpoints.balance`, { id: id.value })),
        queryFn: () => sandboxRpc.endpoints.balance({ id: id.value ?? `` }),
        enabled: computed(() => id.value !== undefined && readsBalance(toValue(provider))),
        staleTime: 30_000,
        retry: false,
    });
    const balance = computed<KeyBalance | undefined>(() => (id.value !== undefined && readsBalance(toValue(provider)) ? query.data.value?.balance : undefined));
    return { balance, refetch: () => void query.refetch() };
};
