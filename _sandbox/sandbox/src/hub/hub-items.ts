import { MINTED_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    type ConnectionEnvelope,
    ConnectionEnvelopeSchema,
    HUB_ACCOUNT_PROVIDERS,
    type HubAccountProvider,
    HubCardKindSchema,
    type HubHolding,
    type HubItem,
    type HubTarget,
    type HubWant,
    hubSlug,
    sameHubTarget,
    wantOfItem,
} from "@intentic/sandbox-contract/schemas/connection-hub";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { parseJsonWith } from "@intentic/base/json";
import type { Services } from "../composition.js";
import { contributionFor, type ResolvedContribution } from "../capabilities/contributions.js";
import { mcpSessionOf } from "../capabilities/mcp-oauth/mcp-session.js";
import { opt } from "../opt.js";
import { type AccountCopyDeps, accountCopyOf } from "./account-copies.js";
import type { HubFile } from "./hub-store.js";

// WHAT MAY GO TO THE CONNECTIONS HUB, AND IN WHAT ENVELOPE (schemas/connection-hub.ts). The rule is the credential's:
// a value that does not rotate travels; one a sign-in renews (an OAuth card, a tool server's sign-in session) would be
// renewed in two places and sign one of them out, so each sandbox signs in to those itself.

export type HubItemsDeps = AccountCopyDeps & Pick<Services, "capabilities">;

const ROTATES = "It is a sign-in this sandbox renews, so another sandbox would sign it out: sign in there instead.";

export class HubRefusal extends Error {}

const isHubAccountProvider = (provider: string): provider is HubAccountProvider => HUB_ACCOUNT_PROVIDERS.some((known) => known === provider);

// Why a card cannot travel, or undefined when it can. Only the hub's kinds are asked.
const cardRefusal = (capability: Capability, connectors: ReadonlyMap<string, ResolvedContribution>): string | undefined => {
    if (capability.kind === "mcp") {
        return mcpSessionOf(capability.config.token) === undefined ? undefined : ROTATES;
    }
    if (capability.kind === "cli") {
        const spec = contributionFor(connectors, "cli", capability.config)?.spec;
        return spec !== undefined && "refreshToken" in spec && spec.refreshToken !== undefined ? ROTATES : undefined;
    }
    return undefined;
};

const cardItem = (capability: Capability): HubItem | undefined => {
    const kind = HubCardKindSchema.safeParse(capability.kind);
    if (!kind.success) {
        return undefined;
    }
    const connector = capability.kind === "cli" ? hubSlug(capability.config.provider) : undefined;
    return { type: "card", id: capability.id, kind: kind.data, ...opt("connector", connector), config: { ...capability.config } };
};

const seenFor = (file: HubFile, target: HubTarget) => file.seen.find((seen) => seen.target !== undefined && sameHubTarget(seen.target, target));

const holding = (file: HubFile, target: HubTarget, label: string, want: HubWant, reason: string | undefined): HubHolding => {
    const saved = file.saved.find((record) => sameHubTarget(record.target, target));
    const seen = seenFor(file, target);
    return {
        target,
        label,
        ...opt("want", reason === undefined ? want : undefined),
        ...opt("reason", reason),
        ...opt("saved", saved === undefined ? undefined : { entry: saved.entry, machine: saved.machine, at: saved.at, pending: saved.pending }),
        ...opt("from", seen?.made === true ? { entry: seen.entry, ...opt("machine", seen.machine) } : undefined),
    };
};

const accountRows = async (deps: HubItemsDeps): Promise<readonly (readonly [HubAccountProvider, readonly OauthAccount[]])[]> => {
    const minted = MINTED_PROVIDERS.filter(isHubAccountProvider);
    const lists = await Promise.all([deps.cursorStore.list(), deps.devinStore.list(), ...minted.map((provider) => deps.minted[provider].store.list())]);
    const providers: readonly HubAccountProvider[] = ["cursor", "devin", ...minted];
    return providers.map((provider, index) => [provider, lists[index] ?? []] as const);
};

/** Every card and static account held here that the hub knows how to carry, and whether each can go. */
export const hubHoldings = async (deps: HubItemsDeps, connectors: ReadonlyMap<string, ResolvedContribution>, file: HubFile): Promise<HubHolding[]> => {
    const [capabilities, accounts] = await Promise.all([deps.capabilities.list(), accountRows(deps)]);
    const cards = capabilities.flatMap((capability) => {
        const item = cardItem(capability);
        return item === undefined ? [] : [holding(file, { type: "card", id: capability.id }, capability.id, wantOfItem(item), cardRefusal(capability, connectors))];
    });
    const rows = accounts.flatMap(([provider, list]) =>
        list.map((row) =>
            holding(file, { type: "account", provider, id: row.id }, row.label, { type: "account", provider }, row.needsReauth === true ? "It needs signing in again here first." : undefined),
        ),
    );
    return [...cards, ...rows];
};

/** The envelope a target goes to the hub in, credential included; refused in words when it cannot go. */
export const envelopeOf = async (
    deps: HubItemsDeps,
    connectors: ReadonlyMap<string, ResolvedContribution>,
    target: HubTarget,
    from: { readonly sandbox: string; readonly at: number },
): Promise<ConnectionEnvelope> => {
    if (target.type === "card") {
        const capability = await deps.capabilities.get(target.id);
        const item = capability === undefined ? undefined : cardItem(capability);
        if (capability === undefined || item === undefined) {
            throw new HubRefusal(`There is no connection "${target.id}" here that the hub can keep.`);
        }
        const refused = cardRefusal(capability, connectors);
        if (refused !== undefined) {
            throw new HubRefusal(refused);
        }
        return { intentic: "connection", v: 1, label: capability.id, from, item };
    }
    if (!isHubAccountProvider(target.provider)) {
        throw new HubRefusal(`A ${target.provider} account is a sign-in, not a key: sign in on each sandbox instead.`);
    }
    const account = await accountCopyOf(deps, target.provider, target.id);
    if (account === undefined) {
        throw new HubRefusal(`There is no ${target.provider} account "${target.id}" here.`);
    }
    return { intentic: "connection", v: 1, label: account.label ?? account.email ?? target.provider, from, item: { type: "account", provider: target.provider, account } };
};

/** A hub entry's value read back, or undefined for one that is not a connection this build reads. */
export const parseEnvelope = (value: string): ConnectionEnvelope | undefined => parseJsonWith(value, ConnectionEnvelopeSchema);
