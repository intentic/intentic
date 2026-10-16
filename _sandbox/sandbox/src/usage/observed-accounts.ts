import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../composition.js";
import { type ObservedLimit, type ObservedReading, observedTurnLimit } from "./observed-limits.js";
import type { TurnLimit } from "./serviceability/fleet-limit.js";

// The allowance of a provider that publishes none, read from the ledger of what it has already refused: one read per
// provider, not one per model, and no knowledge of any particular provider in it. Cursor's API vends /me, /models,
// /agents and /repositories and nothing about allowances; Devin publishes its quota only on its own pages. For both,
// the ledger (observed-limits.ts) is the whole measurement, and before this nothing but the role ladder ever read it:
// the spawn listing judged them on readings fed by Claude's store and the translator, which cover neither, so a spent
// Cursor model stayed listed as "not metered" through seven refused spawns (2026-10-13).
// Also where a mark set BY HAND lands, which is the last resort for a plan that will never report its own state.

/** One provider's accounts, as its own door names them. */
interface ProviderAccount {
    readonly id: string;
    readonly label?: string;
}

// The provider's own account rows, through the door its module publishes. `false`: the listing must not trigger a
// re-measure, and these providers have nothing to measure anyway.
const accountsOf = async (services: Services, provider: AgentProvider): Promise<readonly ProviderAccount[]> => {
    const door = services.providerModules.find((candidate) => candidate.id === provider)?.accounts;
    if (door === undefined) {
        return [];
    }
    return (await door(services).list(false)).map((account) => ({ id: account.id, label: account.label }));
};

/** Every connected account's ledger for one provider, read once. */
export const observedReadings = async (services: Services, provider: AgentProvider): Promise<readonly ObservedReading[]> => {
    const accounts = await accountsOf(services, provider);
    return Promise.all(accounts.map(async (account) => ({ account: account.id, spent: await services.observedLimits.spent(provider, account.id) })));
};

/**
 * What this provider's ledger says of any model, from one read of it. Undefined for a provider that publishes its own
 * allowance (nothing files a ledger entry for it) or one with no accounts connected; a model with no entry has room,
 * measured now, which is what lets one account's spent model still be asked on another.
 */
export const observedOwnLimit = async (
    services: Services,
    provider: AgentProvider,
): Promise<((model: string) => Promise<TurnLimit | undefined>) | undefined> => {
    if (reportsPlanLimits(provider)) {
        return undefined;
    }
    const readings = await observedReadings(services, provider);
    if (readings.length === 0) {
        return undefined;
    }
    // Unnamed labels: every surface reading this names models by id, and naming a pool would cost a catalog read per
    // provider for a string nothing prints.
    return async (model) => observedTurnLimit(readings, { id: model });
};

/** Why a hand-set mark cannot be filed for this provider, or undefined when it can. */
const unmarkable = async (services: Services, provider: AgentProvider): Promise<string | undefined> => {
    // SAFETY: widening the tuple's element type to read a membership test; nothing is narrowed by it, and `provider`
    // arrives as a string from the wire whether or not it names one.
    if (!(NATIVE_PROVIDERS as readonly string[]).includes(provider)) {
        return `There is no provider "${provider}". The ones this sandbox knows: ${NATIVE_PROVIDERS.join(", ")}.`;
    }
    if (reportsPlanLimits(provider)) {
        return `${provider} publishes its own allowance, which every surface reads directly, so a mark set by hand here would be ignored and then overwritten by the next reading. Nothing to mark.`;
    }
    if ((await accountsOf(services, provider)).length === 0) {
        return `No ${provider} account is connected, so there is no allowance to mark. Connect one in Sandbox ▸ Agent ▸ Accounts.`;
    }
    return undefined;
};

/** What a mark or an unmark did, in the words its caller prints. */
export type MarkOutcome = { readonly ok: true; readonly message: string } | { readonly ok: false; readonly message: string };

// Which accounts a mark lands on: the one named, or every connected one, since a plan is usually spent for the
// subscription rather than for one sign-in of it.
const targeted = async (services: Services, provider: AgentProvider, account: string | undefined): Promise<readonly ProviderAccount[]> => {
    const accounts = await accountsOf(services, provider);
    if (account === undefined || account === "") {
        return accounts;
    }
    return accounts.filter((row) => row.id === account || row.label === account);
};

const named = (accounts: readonly ProviderAccount[]): string => accounts.map((account) => account.label ?? account.id).join(", ");

/**
 * Marks one model of a provider spent by hand, for a plan whose state nothing can read. Believed far longer than a
 * refused turn's own record (observed-limits.ts BY_HAND_FOR_MS), since nobody sets one by accident. Re-reads the
 * accounts it marked, so an open picker and the next spawn listing move within the same beat.
 */
export const markSpentByHand = async (
    services: Services,
    asked: { readonly provider: AgentProvider; readonly model: string; readonly account?: string; readonly why?: string },
): Promise<MarkOutcome> => {
    const refusal = await unmarkable(services, asked.provider);
    if (refusal !== undefined) {
        return { ok: false, message: refusal };
    }
    const accounts = await targeted(services, asked.provider, asked.account);
    if (accounts.length === 0) {
        return { ok: false, message: `No ${asked.provider} account matches "${asked.account ?? ""}".` };
    }
    const limit: ObservedLimit = {
        at: Date.now(),
        // Said as a mark, not as a vendor's words: every surface that quotes this prints it to a person.
        message: asked.why === undefined || asked.why === "" ? "Marked out of allowance by hand." : `Marked out of allowance by hand: ${asked.why}`,
        byHand: true,
    };
    await Promise.all(accounts.map(async (account) => services.observedLimits.record(asked.provider, account.id, asked.model, limit)));
    await services.headroom.refresh({ scope: { providers: [asked.provider] }, maxAgeMs: 0 });
    return {
        ok: true,
        message: `${asked.provider}/${asked.model} is marked out of allowance on ${named(accounts)} for the next 24h, or until it is unmarked. It is left out of the spawn listing and a subagent asking for it is refused.`,
    };
};

/** Drops a model's mark (hand-set or a refused turn's), leaving the account's other models alone. */
export const unmarkSpentByHand = async (
    services: Services,
    asked: { readonly provider: AgentProvider; readonly model: string; readonly account?: string },
): Promise<MarkOutcome> => {
    const refusal = await unmarkable(services, asked.provider);
    if (refusal !== undefined) {
        return { ok: false, message: refusal };
    }
    const accounts = await targeted(services, asked.provider, asked.account);
    const dropped = await Promise.all(accounts.map(async (account) => services.observedLimits.forget(asked.provider, account.id, asked.model)));
    await services.headroom.refresh({ scope: { providers: [asked.provider] }, maxAgeMs: 0 });
    if (!dropped.includes(true)) {
        return { ok: true, message: `${asked.provider}/${asked.model} was not marked out of allowance on ${named(accounts)}; nothing to unmark.` };
    }
    return { ok: true, message: `${asked.provider}/${asked.model} is no longer marked out of allowance on ${named(accounts)}; it is spendable again.` };
};
