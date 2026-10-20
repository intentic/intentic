import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { NATIVE_PROVIDERS, type NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { reportsPlanLimits } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../composition.js";

// A plan marked spent by hand: the last resort for a plan that will never report its own state (Cursor's API vends
// nothing about allowances; Devin publishes its quota only on its own pages). Filed in the one refusal ledger
// (provider-refusals.ts) as the refusal a turn would have filed, so the spawn listing, the role ladder, the account rows
// and the picker read it the way they read any other: no surface keeps a list of marks of its own.

/** One provider's accounts, as its own door names them. */
interface ProviderAccount {
    readonly id: string;
    readonly label?: string;
}

// SAFETY: only reached past unmarkable's membership test, so `provider` is one of NATIVE_PROVIDERS.
const accountsOf = async (services: Pick<Services, "providerAccounts">, provider: AgentProvider): Promise<readonly ProviderAccount[]> =>
    services.providerAccounts(provider as NativeProvider);

/** Why a hand-set mark cannot be filed for this provider, or undefined when it can. */
const unmarkable = async (services: Pick<Services, "providerAccounts">, provider: AgentProvider): Promise<string | undefined> => {
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
const targeted = async (services: Pick<Services, "providerAccounts">, provider: AgentProvider, account: string | undefined): Promise<readonly ProviderAccount[]> => {
    const accounts = await accountsOf(services, provider);
    if (account === undefined || account === "") {
        return accounts;
    }
    return accounts.filter((row) => row.id === account || row.label === account);
};

const named = (accounts: readonly ProviderAccount[]): string => accounts.map((account) => account.label ?? account.id).join(", ");

type MarkDeps = Pick<Services, "providerAccounts" | "providerRefusals">;

/**
 * Marks one model of a provider spent by hand, for a plan whose state nothing can read. Believed for a day
 * (provider-refusals.ts ENTITLEMENT_FOR_MS), since nobody sets one by accident; a turn answered on the model settles it
 * sooner, as it would a refused turn's.
 */
export const markSpentByHand = async (
    services: MarkDeps,
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
    // Said as a mark, not as a vendor's words: every surface that quotes this prints it to a person.
    const message = asked.why === undefined || asked.why === "" ? "Marked out of allowance by hand." : `Marked out of allowance by hand: ${asked.why}`;
    const at = Date.now();
    await Promise.all(
        accounts.map(async (account) =>
            services.providerRefusals.record(asked.provider, { at, kind: "limit", message, account: account.id, model: asked.model, byHand: true }),
        ),
    );
    return {
        ok: true,
        message: `${asked.provider}/${asked.model} is marked out of allowance on ${named(accounts)} for the next 24h, or until it is unmarked. It is left out of the spawn listing and a subagent asking for it is refused.`,
    };
};

/** Drops a model's mark (hand-set or a refused turn's), leaving the account's other models alone. */
export const unmarkSpentByHand = async (
    services: MarkDeps,
    asked: { readonly provider: AgentProvider; readonly model: string; readonly account?: string },
): Promise<MarkOutcome> => {
    const refusal = await unmarkable(services, asked.provider);
    if (refusal !== undefined) {
        return { ok: false, message: refusal };
    }
    const accounts = await targeted(services, asked.provider, asked.account);
    const dropped = await Promise.all(
        accounts.map(async (account) =>
            services.providerRefusals.drop(asked.provider, (filed) => filed.kind === "limit" && filed.account === account.id && filed.model === asked.model),
        ),
    );
    if (!dropped.includes(true)) {
        return { ok: true, message: `${asked.provider}/${asked.model} was not marked out of allowance on ${named(accounts)}; nothing to unmark.` };
    }
    return { ok: true, message: `${asked.provider}/${asked.model} is no longer marked out of allowance on ${named(accounts)}; it is spendable again.` };
};
