import { randomUUID } from "node:crypto";
import { MINTED_PROVIDERS, type MintedProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AccountCopy, StaticAccountCopy } from "@intentic/sandbox-contract/schemas/providers/account-sharing";
import { sameAccount } from "../../agent/providers/accounts/account-identity.js";
import type { Services } from "../../composition.js";
import { endpointId } from "../../migrations/provider-keys.js";
import { opt } from "../../opt.js";

// A STATIC ACCOUNT ARRIVING from another of the owner's sandboxes (account-sharing.ts in the contract), written into this
// sandbox's own store for its provider as a sign-in here would write it: the one connect rule (account-identity.ts)
// lands the same person on their account again, same id, so bringing one in twice leaves one row. After this the copy
// is this sandbox's own: nothing ties it to the source, which is why only a key that does not rotate is copied.

export interface CopyInDeps extends Pick<Services, "cursorStore" | "devinStore" | "devinModels" | "minted" | "capabilities"> {
    // Applies and stores one new model endpoint, the capability route's own sequence (migrations/provider-keys.ts).
    readonly addEndpoint: (capability: Capability) => Promise<void>;
}

const isMinted = (provider: string): provider is MintedProvider => MINTED_PROVIDERS.some((minted) => minted === provider);

const copyCursor = async (deps: CopyInDeps, copy: StaticAccountCopy): Promise<string> => {
    const match = sameAccount(await deps.cursorStore.list(), opt("email", copy.email));
    const kept = match === undefined ? undefined : await deps.cursorStore.read(match.id);
    const id = kept?.id ?? randomUUID();
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

const copyDevin = async (deps: CopyInDeps, copy: StaticAccountCopy): Promise<string> => {
    const match = sameAccount(await deps.devinStore.list(), opt("email", copy.email));
    const kept = match === undefined ? undefined : await deps.devinStore.read(match.id);
    const id = kept?.id ?? randomUUID();
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

const copyMinted = async (deps: CopyInDeps, provider: MintedProvider, copy: StaticAccountCopy): Promise<string> => {
    if (copy.variant === undefined) {
        throw new Error("The copy names no sign-in estate, so this sandbox cannot tell which host its key is good against.");
    }
    const slice = deps.minted[provider];
    const row = await slice.store.connect({ apiKey: copy.apiKey, variant: copy.variant, ...opt("email", copy.email) });
    if (copy.label !== undefined && copy.label.trim() !== "" && row.label !== copy.label) {
        await slice.store.rename(row.id, copy.label);
    }
    slice.catalog.forget();
    return row.id;
};

// A model endpoint: the same address and key already here is the same endpoint; otherwise a new one under the source's
// id, numbered past the ids already taken.
const copyEndpoint = async (deps: CopyInDeps, copy: Extract<AccountCopy, { kind: "endpoint" }>): Promise<string> => {
    const capabilities = await deps.capabilities.list();
    const same = capabilities.find(
        (capability) => capability.kind === "endpoint" && capability.config.baseUrl === copy.config.baseUrl && capability.config.apiKey === copy.config.apiKey,
    );
    if (same !== undefined) {
        return same.id;
    }
    const capability = CapabilitySchema.parse({ id: endpointId(copy.id, new Set(capabilities.map((candidate) => candidate.id))), kind: "endpoint", config: copy.config });
    await deps.addEndpoint(capability);
    return capability.id;
};

/** Writes one arriving copy into this sandbox's store for `provider`, answering the account's id here. */
export const copyIn = async (deps: CopyInDeps, provider: string, copy: AccountCopy): Promise<string> => {
    if (copy.kind === "endpoint") {
        return await copyEndpoint(deps, copy);
    }
    if (provider === "cursor") {
        return await copyCursor(deps, copy.account);
    }
    if (provider === "devin") {
        return await copyDevin(deps, copy.account);
    }
    if (isMinted(provider)) {
        return await copyMinted(deps, provider, copy.account);
    }
    throw new Error(`This sandbox keeps no ${provider} account it could copy a key into.`);
};
