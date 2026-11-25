import type { AccountState, AccountUsage, ProviderRefusal, TranslatorAccounts } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { flappingAccounts, type ServiceFacts, serviceStates, type SwitchOffs } from "@intentic/sandbox-contract/models/plan-pools";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { CapacityAccount, ProviderCapacity, ProviderDegraded } from "@intentic/sandbox-contract/schemas/providers/capacity";
import { watch } from "vue";
import { sandboxNow } from "../../agent-status/sandboxClock";
import { lookupUsage, providerAccounts, providerCapacities, providerRefusals, providerSwitchOffs, translatorAccounts } from "../providerAccounts";
import { verdictNow } from "./verdictClock";

/* WHAT THE VERDICT DOOR JUDGES (usageStatus.ts), from one of two sources chosen per provider: the capacity the daemon
   judged and sent whole (providerAccounts.ts providerCapacities), whenever this window holds one, or, against a daemon from
   before it, the four stores that arrive apart (the native rows, the routed credentials, the readings pushed one account
   at a time, the refusals and switch-offs on file). Either way the verdict is the contract's rule (plan-pools.ts
   serviceStates), asked by the door at the sandbox's clock, never a verdict carried over from an earlier instant: a
   capacity's own `state` is what the daemon reached at `judgedAt`, and only the parity check below reads it.
   2026-11-19: each surface used to build its own picture from those four stores with its own account filter and its own
   clock, and several never asked again as the clock moved; rejected for this one door, which every surface asks with only
   its own filter. */

// An account row as the daemon sends it, whichever list it came in: the facts the serviceability rule reads.
export type AccountFacts = ServiceFacts;

/** A provider's own account row, as the serviceability rule reads it. */
export const accountFacts = (account: OauthAccount): AccountFacts => ({
    account: account.id,
    needsReauth: account.needsReauth,
    detail: account.detail,
    seatRefusal: account.seatRefusal,
    usage: account.usage,
    label: account.label,
});

/** A routed credential, as the serviceability rule reads it. */
export const routedAccountFacts = (account: TranslatorAccounts[keyof TranslatorAccounts][number]): AccountFacts => ({
    account: account.name,
    usage: account.usage,
    cooling: account.cooling,
    cooldowns: account.cooldowns,
    label: account.label,
    models: account.models,
});

/** The capacity the daemon last judged for a provider, while this window holds one; undefined against an older daemon. */
export const capacityOf = (provider: AgentProvider): ProviderCapacity | undefined => providerCapacities.value[provider];

// One account of a held capacity as the rule reads it: its facts, without the verdict the daemon reached at `judgedAt`.
const judgedFacts = ({ state: _state, flapping: _flapping, ...facts }: CapacityAccount): AccountFacts => facts;

// The held capacity's entry for one account, where it lists it.
const judgedAccount = (provider: AgentProvider, account: string): CapacityAccount | undefined =>
    capacityOf(provider)?.accounts.find((entry) => entry.account === account);

/**
 * The reading an account is judged and drawn by: the held capacity's where it lists the account, else the shared map
 * (providerAccounts.usageByAccount) if present, else the attached row a caller holds (planLimitRows). The map wins over
 * a row: turns and daemon pushes keep it current.
 */
export const freshest = (provider: AgentProvider, account: string, attached: AccountUsage | undefined): AccountUsage | undefined => {
    const judged = judgedAccount(provider, account);
    return judged === undefined ? (lookupUsage(provider, account) ?? attached) : judged.usage;
};

/** Every refusal on file for a provider: the held capacity's, else as the daemon holds them (agent.refusals, then pushes). */
export const refusalsOf = (provider: AgentProvider): readonly ProviderRefusal[] => capacityOf(provider)?.refusals ?? providerRefusals.value[provider] ?? [];

// Each account's switch-offs this week, the facts a pick ranks a flapping account by: the held capacity's, else as the
// refusals feed carries them.
const switchOffsOf = (provider: AgentProvider): SwitchOffs | undefined => {
    const capacity = capacityOf(provider);
    return capacity === undefined ? providerSwitchOffs.value[provider] : capacity.switchOffs;
};

/** The accounts of a provider its organisation keeps switching off, at the sandbox's clock (plan-pools.ts flappingAccounts). */
export const flappingOf = (provider: AgentProvider, now: number = verdictNow()): ReadonlySet<string> =>
    flappingAccounts(switchOffsOf(provider), sandboxNow(now));

/** The provider itself failing or throttling turns, and when the sandbox tries it again, as the daemon last said. */
export const degradedOf = (provider: AgentProvider): ProviderDegraded | undefined => capacityOf(provider)?.degraded;

// Translator subscriptions for a provider, or none if it holds no auth files for it.
const routedAccounts = (provider: AgentProvider): TranslatorAccounts[keyof TranslatorAccounts] =>
    // SAFETY: a provider the translator does not route indexes no slot, and the lookup answers undefined, read as none.
    translatorAccounts.value[provider as keyof TranslatorAccounts] ?? [];

// Every connection a provider holds (native and routed are one list to the reader, as they are to the daemon's
// accountFactsOf), each with its freshest raw reading: never one the refusals were laid on, since judging a refusal on
// such a reading would let a pinned 100% feed itself forever. Assembled from the stores; what an older daemon leaves.
// compat(daemon<1.428.0): the daemon's judged capacity (usage.capacity)
const assembledFacts = (provider: AgentProvider): readonly AccountFacts[] =>
    [...(providerAccounts.value[provider] ?? []).map(accountFacts), ...routedAccounts(provider).map(routedAccountFacts)].map((facts) => ({
        ...facts,
        usage: lookupUsage(provider, facts.account) ?? facts.usage,
    }));

/** The provider's accounts as the rule reads them: as the daemon judged them where a capacity is held, else assembled. */
export const providerFacts = (provider: AgentProvider): readonly AccountFacts[] => {
    const capacity = capacityOf(provider);
    return capacity === undefined ? assembledFacts(provider) : capacity.accounts.map(judgedFacts);
};

/**
 * One account's facts as the door holds them: the capacity's where it lists the account, else the row a caller holds (an
 * account connected a moment ago, which no capacity has judged yet) with its freshest reading.
 */
export const factsOf = (provider: AgentProvider, held: AccountFacts): AccountFacts => {
    const judged = judgedAccount(provider, held.account);
    return judged === undefined ? { ...held, usage: freshest(provider, held.account, held.usage) } : judgedFacts(judged);
};

/** The provider's facts with one account's row patched by what a caller holds, or added where the lists lack it yet. */
export const withRow = (facts: readonly AccountFacts[], account: string, patch: Partial<AccountFacts>): readonly AccountFacts[] =>
    facts.some((entry) => entry.account === account)
        ? facts.map((entry) => (entry.account === account ? { ...entry, ...patch } : entry))
        : [...facts, { ...patch, account }];

/* A DEVELOPMENT BUILD CHECKS THAT THE TWO SOURCES AGREE. Where this window holds a provider's capacity and the four stores
   as well, each account's verdict with no model named is judged again from the stores, at the instant the daemon judged
   the capacity, and a disagreement is warned once, naming the account and both verdicts: a fact one side reads and the
   other does not, which the switch to the daemon's picture would otherwise hide. Never in a shipped build. */

/** One account whose verdict the daemon's capacity and this window's own stores disagree on. */
export interface ParityMismatch {
    readonly provider: string;
    readonly account: string;
    readonly judged: AccountState;
    readonly assembled: AccountState;
}

// What a disagreement is told by: the verdict's kind, and for a blocked account who has to act. The room and instants
// move with a reading taken a moment apart, which is not a disagreement about the rule.
const verdictWords = (state: AccountState): string => (state.kind === `blocked` ? `blocked:${state.fix}` : state.kind);

/** Every account the held capacity and the stores judge differently, at the capacity's own instant. */
export const capacityMismatches = (capacity: ProviderCapacity): readonly ParityMismatch[] => {
    const assembled = assembledFacts(capacity.provider);
    if (assembled.length === 0) {
        return [];
    }
    const states = serviceStates(assembled, providerRefusals.value[capacity.provider] ?? [], undefined, capacity.judgedAt);
    return capacity.accounts.flatMap((entry) => {
        const own = states.get(entry.account);
        return own === undefined || verdictWords(own) === verdictWords(entry.state)
            ? []
            : [{ provider: capacity.provider, account: entry.account, judged: entry.state, assembled: own }];
    });
};

// Each disagreement warned once per page, however many capacities repeat it.
const warned = new Set<string>();

/** Warns each new disagreement between a capacity and the stores; what a development build runs as capacities land. */
export const checkCapacityParity = (capacity: ProviderCapacity): void => {
    for (const mismatch of capacityMismatches(capacity)) {
        const key = `${mismatch.provider}:${mismatch.account}:${verdictWords(mismatch.judged)}:${verdictWords(mismatch.assembled)}`;
        if (warned.has(key)) {
            continue;
        }
        warned.add(key);
        console.warn(`capacity parity: ${mismatch.provider} account ${mismatch.account} is judged differently`, {
            daemon: mismatch.judged,
            window: mismatch.assembled,
        });
    }
};

// The reading or refusal a capacity was judged on arrives on its own frame, a moment before or after it: compared once
// both have landed, not the instant the capacity does.
const PARITY_SETTLE_MS = 3_000;

// Armed only while a capacity is held: with none there is nothing to compare, and a timer armed on every change (a
// sandbox's scope emptying it included) is a timer every other wait in the window then shares its instants with.
if (import.meta.env.DEV) {
    let due: ReturnType<typeof setTimeout> | undefined;
    watch(providerCapacities, (held) => {
        clearTimeout(due);
        if (Object.keys(held).length === 0) {
            return;
        }
        due = setTimeout(() => {
            for (const capacity of Object.values(providerCapacities.value)) {
                checkCapacityParity(capacity);
            }
        }, PARITY_SETTLE_MS);
    });
}
