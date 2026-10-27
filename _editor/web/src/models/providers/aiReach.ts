import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { aiAccountAllowed } from "@intentic/sandbox-contract/schemas/members";
import type { FleetCapacity } from "@intentic/sandbox-contract/models/plan-pools";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { ComputedRef } from "vue";
import { selfAiAccounts } from "../../client/sandbox/useMembers";
import { providerAccounts, translatorAccounts } from "./providerAccounts";
import { isLocalModelProvider } from "./providerCatalog";
import { modelCapacity } from "./usageStatus";

/* WHICH AI ACCOUNTS THE SIGNED-IN PERSON MAY RUN A TURN ON (Access ▸ People, a person's AI accounts), read the way the
   daemon decides a turn's account (sandbox agent/run/decide/account-reach.ts), so a surface offers only what will run
   rather than letting a send find out. A second question beside "is it connected" (access.ts `providerReady`): a
   provider can be connected here and still not be the person's to spend, and the way on differs (another model, or the
   owner's grant, never Connect).
   - Nobody limited them: every account, and also the answer until their access read lands.
   - A local model spends nobody's allowance: never held back.
   - A provider's own key (`claude`) hands over every account of it, including any connected later.
   - A provider holding accounts is theirs when one of its accounts is on their list.
   - A provider holding none this window can see (an API-key endpoint, an installed agent, the free trial, or a reader
     who may not list accounts) is judged by its own key; a key naming one of its accounts still counts, since the
     daemon may hold that account where this window cannot see it.
   The daemon stays the judge: it refuses whatever this misreads. */

let mine: ComputedRef<readonly string[] | undefined> | undefined;

/** The keys the signed-in person is held to, as Access ▸ People writes them; undefined is every account. */
export const myAiAccounts = (): readonly string[] | undefined => (mine ??= selfAiAccounts()).value;

/** Whether the signed-in person may run a turn on one account of a provider. */
export const mayRunOn = (provider: AgentProvider, account: string): boolean => {
    const keys = myAiAccounts();
    return keys === undefined || aiAccountAllowed(keys, provider, account);
};

// Every account a provider holds, native and routed: the same two lists the daemon's account list reads.
const heldAccounts = (provider: AgentProvider): readonly string[] => {
    const routed = KeyedProviderSchema.safeParse(provider);
    return [
        ...(providerAccounts.value[provider] ?? []).map((account) => account.id),
        ...(routed.success ? translatorAccounts.value[routed.data] : []).map((account) => account.name),
    ];
};

/** Whether the signed-in person may run nothing on this provider: it is not shared with them, connected or not. */
export const providerWithheld = (provider: AgentProvider): boolean => {
    const keys = myAiAccounts();
    if (keys === undefined || isLocalModelProvider(provider) || aiAccountAllowed(keys, provider, undefined)) {
        return false;
    }
    const held = heldAccounts(provider);
    return held.length > 0 ? !held.some((account) => aiAccountAllowed(keys, provider, account)) : !keys.some((key) => key.startsWith(`${provider}:`));
};

/**
 * Of some picker rows (a key, the provider, the model), those no account of the signed-in person's can serve now, each
 * with when one is back: a spent account of theirs is not made good by another account's room they may not spend.
 */
export const spentModels = (
    rows: readonly { readonly key: string; readonly provider: AgentProvider; readonly value: string; readonly label: string }[],
    now: number = Date.now(),
): ReadonlyMap<string, FleetCapacity & { readonly kind: `spent` }> =>
    new Map(
        rows.flatMap((row) => {
            const capacity = modelCapacity(row.provider, { id: row.value, label: row.label }, now, (account) => mayRunOn(row.provider, account));
            return capacity.kind === `spent` ? [[row.key, capacity] as const] : [];
        }),
    );
