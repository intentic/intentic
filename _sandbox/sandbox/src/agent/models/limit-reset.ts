import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { Services } from "../../composition.js";
import { windowPeriod } from "@intentic/sandbox-contract/models/plan-pools";
import type { UsageWindow } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { accountLimitReset } from "../../usage/account-usage.js";

// Tries the account's own snapshot first (native Claude, filed per account), then the translator's per-model pool for
// other routed providers, since those key by subscription, not account. Never throws; `undefined` is a real answer:
// some providers (Grok, Cursor) publish no readable quota, and a reset is withheld while any account still has
// headroom.
// The reset of the pool a refusal named by its length ("your 5-hour usage limit"), off a reading of the account, or of
// any of a routed provider's accounts (the soonest, since the translator routes to whichever reopens first). The pool
// may not read full yet, since a reading freezes before the pool empties; the vendor's sentence is what says it did.
const namedPoolReset = (windows: readonly UsageWindow[], period: number, nowSeconds: number): number | undefined =>
    windows
        .filter((window) => windowPeriod(window)?.seconds === period && window.resetsAt !== undefined && window.resetsAt > nowSeconds)
        .reduce<number | undefined>((soonest, window) => (soonest === undefined || (window.resetsAt ?? soonest) < soonest ? window.resetsAt : soonest), undefined);

const periodReset = async (params: { readonly services: Services; readonly provider: AgentProvider; readonly account: string | undefined; readonly period: number }) => {
    const { services, provider, account, period } = params;
    const nowSeconds = Date.now() / 1000;
    const routed = KeyedProviderSchema.safeParse(provider);
    if (routed.success) {
        // allow(silent-catch): this answers "when", never throws; an unreadable translator leaves the snapshot to answer.
        const accounts = (await services.cliProxy.accounts().catch(() => undefined))?.[routed.data] ?? [];
        return namedPoolReset(
            accounts.flatMap((row) => row.usage?.windows ?? []),
            period,
            nowSeconds,
        );
    }
    if (account === undefined) {
        return undefined;
    }
    // allow(silent-catch): this answers "when", never throws; an unreadable usage file leaves the snapshot to answer.
    const usage = (await services.accountUsage.read().catch(() => undefined))?.[account];
    return namedPoolReset(usage?.windows ?? [], period, nowSeconds);
};

export const limitReopensAt = async (params: {
    readonly services: Services;
    readonly provider: AgentProvider;
    readonly model: string | undefined;
    readonly account: string | undefined;
    // The length of the pool the refusal's sentence named, in seconds; its reset is the answer where a reading has it.
    readonly period?: number | undefined;
}): Promise<number | undefined> => {
    const { services, provider, model, account } = params;
    if (params.period !== undefined) {
        const named = await periodReset({ services, provider, account, period: params.period });
        if (named !== undefined) {
            return named;
        }
    }
    const stored = await accountLimitReset(services.accountUsage, account, model === undefined || model === "" ? undefined : { id: model }).catch(
        () => undefined,
    );
    if (stored !== undefined) {
        return stored;
    }
    const routed = KeyedProviderSchema.safeParse(provider);
    if (!routed.success || model === undefined || model === "") {
        return undefined;
    }
    const limit = await services.cliProxy.turnLimit(routed.data, model).catch(() => undefined);
    return limit?.reopensAt;
};
