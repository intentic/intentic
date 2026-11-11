import { randomUUID } from "node:crypto";
import { MINTED_PROVIDERS, type MintedProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { HubAccountProvider, StaticAccountCopy } from "@intentic/sandbox-contract/schemas/connection-hub";
import { forgetAccountState, sameAccount } from "../agent/providers/accounts/account-identity.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";

// A STATIC MODEL ACCOUNT going to or coming from the connections hub (schemas/connection-hub.ts): read out of this
// sandbox's store for its provider, or written into it as a sign-in here would write it. The one connect rule
// (account-identity.ts) lands the same person on their account again, same id, so taking one in twice leaves one row.
// Only a key that does not rotate travels, so the copy here and the entry on the computer never race to renew it.

export type AccountCopyDeps = Pick<Services, "cursorStore" | "devinStore" | "devinModels" | "minted" | "headroom" | "providerRefusals">;

const isMinted = (provider: string): provider is MintedProvider => MINTED_PROVIDERS.some((minted) => minted === provider);

/** One static account's value as the hub keeps it; undefined when this sandbox holds no such account. */
export const accountCopyOf = async (deps: AccountCopyDeps, provider: HubAccountProvider, id: string): Promise<StaticAccountCopy | undefined> => {
    if (provider === "cursor") {
        const stored = await deps.cursorStore.read(id);
        return stored === undefined
            ? undefined
            : {
                  apiKey: stored.apiKey,
                  ...opt("label", stored.label),
                  ...opt("email", stored.email),
                  ...opt("apiKeyExpiresAtMs", stored.apiKeyExpiresAtMs),
                  ...opt("backendUrl", stored.backendUrl),
              };
    }
    if (provider === "devin") {
        const stored = await deps.devinStore.read(id);
        return stored === undefined ? undefined : { apiKey: stored.apiKey, ...opt("label", stored.label), ...opt("email", stored.email), ...opt("plan", stored.plan) };
    }
    if (!isMinted(provider)) {
        return undefined;
    }
    const stored = (await deps.minted[provider].store.credentials()).find((candidate) => candidate.id === id);
    return stored === undefined ? undefined : { apiKey: stored.apiKey, variant: stored.variant, ...opt("label", stored.label), ...opt("email", stored.email) };
};

const copyCursor = async (deps: AccountCopyDeps, copy: StaticAccountCopy, into: string | undefined): Promise<string> => {
    const match = into === undefined ? sameAccount(await deps.cursorStore.list(), opt("email", copy.email)) : { id: into };
    const kept = match === undefined ? undefined : await deps.cursorStore.read(match.id);
    const id = kept?.id ?? into ?? randomUUID();
    await deps.cursorStore.write({
        id,
        ...opt("label", kept?.label ?? copy.label),
        ...opt("email", copy.email),
        apiKey: copy.apiKey,
        ...opt("apiKeyExpiresAtMs", copy.apiKeyExpiresAtMs),
        ...opt("backendUrl", copy.backendUrl),
        connectedAt: kept?.connectedAt ?? Date.now(),
    });
    return id;
};

const copyDevin = async (deps: AccountCopyDeps, copy: StaticAccountCopy, into: string | undefined): Promise<string> => {
    const match = into === undefined ? sameAccount(await deps.devinStore.list(), opt("email", copy.email)) : { id: into };
    const kept = match === undefined ? undefined : await deps.devinStore.read(match.id);
    const id = kept?.id ?? into ?? randomUUID();
    await deps.devinStore.write({
        id,
        ...opt("label", kept?.label ?? copy.label),
        ...opt("email", copy.email),
        ...opt("plan", copy.plan),
        apiKey: copy.apiKey,
        connectedAt: kept?.connectedAt ?? Date.now(),
    });
    deps.devinModels.forget();
    return id;
};

const copyMinted = async (deps: AccountCopyDeps, provider: MintedProvider, copy: StaticAccountCopy): Promise<string> => {
    if (copy.variant === undefined) {
        throw new Error("The saved key names no sign-in estate, so this sandbox cannot tell which host it is good against.");
    }
    const slice = deps.minted[provider];
    // The minted store lands the same key and estate on the account it already keeps, so a changed entry updates it.
    const row = await slice.store.connect({ apiKey: copy.apiKey, variant: copy.variant, ...opt("email", copy.email) });
    if (copy.label !== undefined && copy.label.trim() !== "" && row.label !== copy.label) {
        await slice.store.rename(row.id, copy.label);
    }
    slice.catalog.forget();
    return row.id;
};

/** Writes one hub account into this sandbox's store for `provider` (over `into` when it made one before), answering its id. */
export const copyAccountIn = async (deps: AccountCopyDeps, provider: HubAccountProvider, copy: StaticAccountCopy, into?: string): Promise<string> => {
    if (provider === "cursor") {
        return await copyCursor(deps, copy, into);
    }
    if (provider === "devin") {
        return await copyDevin(deps, copy, into);
    }
    if (isMinted(provider)) {
        return await copyMinted(deps, provider, copy);
    }
    throw new Error(`This sandbox keeps no ${provider} account it could take a key into.`);
};

/** Takes one account the hub made here away again, with what the daemon kept about it. */
export const forgetAccount = async (deps: AccountCopyDeps, provider: HubAccountProvider, id: string): Promise<void> => {
    if (provider === "cursor") {
        await deps.cursorStore.clear(id);
    } else if (provider === "devin") {
        await deps.devinStore.clear(id);
        deps.devinModels.forget();
    } else if (isMinted(provider)) {
        await deps.minted[provider].store.disconnect(id);
        deps.minted[provider].catalog.forget();
    }
    await forgetAccountState(deps, provider, id);
};
