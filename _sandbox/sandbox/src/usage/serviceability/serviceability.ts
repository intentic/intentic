import type { AccountState, TranslatorAccount, TranslatorAccounts } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { NATIVE_PROVIDERS, type NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { type FleetCapacity, fleetOf, type ModelRef, reopensAtOf, type ServiceFacts, serviceStates } from "@intentic/sandbox-contract/models/plan-pools";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { Services } from "../../composition.js";
import { accountStateLogFor } from "./state-log.js";

// "Can this account serve a turn, and what can this provider's accounts serve together?", answered in one place. The rule
// itself is the contract's (`serviceStates`, `fleetOf` in models/plan-pools.ts), which the editor runs too; this module
// feeds it every fact the daemon holds, for every provider the same way: the accounts as their own door or the translator
// lists them (revoke marks, seat refusals, benches, plan-limit readings), and every refusal on file. Every picker, gate,
// listing and booking in the daemon asks here and nowhere else.

// `logger`, where given, records each change of an account's verdict (state-log.ts); the daemon's callers pass the whole
// services, which carry it.
export type ServiceabilityDeps = Pick<Services, "accountUsage" | "claudeSeats" | "claudeStore" | "cliProxy" | "providerAccounts" | "providerRefusals"> &
    Partial<Pick<Services, "logger">>;

const routed = (provider: AgentProvider): provider is keyof TranslatorAccounts => (KeyedProviderSchema.options as readonly string[]).includes(provider);
const native = (provider: AgentProvider): provider is NativeProvider => (NATIVE_PROVIDERS as readonly string[]).includes(provider);

const nativeFacts = (account: OauthAccount): ServiceFacts => ({
    account: account.id,
    needsReauth: account.needsReauth,
    detail: account.detail,
    seatRefusal: account.seatRefusal,
    usage: account.usage,
    label: account.label,
});

const routedFacts = (account: TranslatorAccount): ServiceFacts => ({ account: account.name, label: account.label, usage: account.usage, cooling: account.cooling });

/**
 * Every connected account of a provider as the rule reads it, in the provider's own order: Claude's from its own store
 * with their seat marks joined in (the store's rows carry none, which is how the limit move once landed on a seatless
 * account); any other's from both places they live, its own door (Cursor, Devin, the minted providers, Grok's own key)
 * and the translator's auth files, bench included (every routed subscription). A door's row carries no reading where
 * the plan publishes none. Empty for a provider with none.
 */
export const accountFactsOf = async (deps: ServiceabilityDeps, provider: AgentProvider): Promise<readonly ServiceFacts[]> => {
    if (provider === "claude") {
        const [accounts, seats, usage] = await Promise.all([deps.claudeStore.list(), deps.claudeSeats.read(), deps.accountUsage.read()]);
        return accounts.map((account) => ({ ...nativeFacts(account), seatRefusal: seats[account.id]?.reason, usage: usage[account.id] }));
    }
    const [door, translator] = await Promise.all([
        native(provider) ? deps.providerAccounts(provider) : [],
        routed(provider) ? deps.cliProxy.accounts().then((accounts) => accounts[provider]) : [],
    ]);
    return [...door.map(nativeFacts), ...translator.map(routedFacts)];
};

// Every account's facts and its verdict, judged together; each change of a verdict is logged where a logger is given.
const judged = async (
    deps: ServiceabilityDeps,
    provider: AgentProvider,
    model: ModelRef | undefined,
    now: number = Date.now(),
): Promise<{ readonly facts: readonly ServiceFacts[]; readonly states: ReadonlyMap<string, AccountState> }> => {
    // The store's read first: a read that throws before it returns a promise then leaves no fact-gathering running
    // with nobody to hear it fail.
    const [refusals, facts] = await Promise.all([deps.providerRefusals.onFile(), accountFactsOf(deps, provider)]);
    const states = serviceStates(facts, refusals[provider], model, now);
    if (deps.logger !== undefined) {
        accountStateLogFor(deps.logger).note(provider, facts, states, refusals[provider] ?? [], model);
    }
    return { facts, states };
};

/** Every account of a provider with its verdict, in the provider's own order. `model` scopes the plan-limit half to the pools it spends. */
export const serviceabilities = async (
    deps: ServiceabilityDeps,
    provider: AgentProvider,
    model?: ModelRef,
): Promise<readonly { readonly id: string; readonly state: AccountState }[]> => {
    const { facts, states } = await judged(deps, provider, model);
    return facts.map((entry) => ({ id: entry.account, state: states.get(entry.account) ?? { kind: "unknown" } }));
};

/** One account's verdict; `unknown` for an account the provider does not hold. */
export const serviceability = async (deps: ServiceabilityDeps, provider: AgentProvider, account: string, model?: ModelRef): Promise<AccountState> =>
    (await serviceabilities(deps, provider, model)).find((entry) => entry.id === account)?.state ?? { kind: "unknown" };

/** What a provider's accounts can serve of one model together: what every gate, listing and offer reads (fleetOf). */
export const fleetCapacityOf = async (deps: ServiceabilityDeps, provider: AgentProvider, model: ModelRef | undefined, now: number = Date.now()): Promise<FleetCapacity> => {
    const { facts, states } = await judged(deps, provider, model, now);
    return fleetOf(facts, states);
};

/* WOULD A TURN ON THIS ACCOUNT BE REFUSED FOR A SPENT ALLOWANCE, AND UNTIL WHEN? Asked by everything that sends or books
   a turn nobody pressed: the allowance gate on a person's released words (allowance-gate.ts), a pick that re-points a
   held turn (switch-account.ts), and the resume pass before it fires a hold (turn-resume.ts). Each used to read it its
   own way, and they disagreed: the pick read the polled reading alone, where every Claude pool is rounded and so never
   proven spent, and re-booked a held turn for now onto an account the records had called spent for an hour, while the
   composer counted down to its real reopen (2026-10-19). Read straight off the account's verdict, so the wall and the
   account rows cannot name different instants. */

/**
 * What stands between one account and a turn on one model when the allowance is the obstacle: its reopening (epoch s),
 * `{}` where it is spent with no instant named. Undefined while it can serve, while nothing has measured it, and where a
 * credential is in the way rather than an allowance (a revoked sign-in, a lost seat, a bench no wait lifts), since a wait
 * answers none of those. Judged at `now`, the caller's own instant.
 */
export interface AllowanceWall {
    readonly reopensAt?: number;
}

export const allowanceWall = async (
    deps: ServiceabilityDeps,
    provider: AgentProvider,
    account: string,
    model?: ModelRef,
    now: number = Date.now(),
): Promise<AllowanceWall | undefined> => {
    const state = (await judged(deps, provider, model, now)).states.get(account);
    if (state === undefined || !(state.kind === "spent" || (state.kind === "blocked" && state.fix === "wait"))) {
        return undefined;
    }
    const reopensAt = reopensAtOf(state);
    return reopensAt === undefined ? {} : { reopensAt };
};
