import { type AgentProvider, KeyedProviderSchema } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { accountLimitReset } from "../../usage/account-usage.js";

// Tries the account's own snapshot first (native Claude, filed per account), then the translator's per-model pool for
// other routed providers, since those key by subscription, not account. Never throws; `undefined` is a real answer:
// some providers (Grok, Cursor) publish no readable quota, and a reset is withheld while any account still has
// headroom.
export const limitReopensAt = async (params: {
    readonly services: Services;
    readonly provider: AgentProvider;
    readonly model: string | undefined;
    readonly account: string | undefined;
}): Promise<number | undefined> => {
    const { services, provider, model, account } = params;
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
