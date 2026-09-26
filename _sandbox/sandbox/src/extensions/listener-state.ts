import type { CliConfig } from "@intentic/sandbox-contract";
import type { AutomationRecord } from "../automations/automations-store.js";
import { cachedEnabledExtensions, contributionFor, contributionKey, contributionRegistry } from "../capabilities/contributions.js";
import type { Services } from "../composition.js";
import type { ExtensionHost, InstalledExtension } from "./installed-extensions.js";

// Provider's listener state: both the reconcile feed the gateway polls and the daemon's spawn gate, one computation.
// Connector configs carry their secrets; the gateway needs the bot token to connect.
export interface ListenerState {
    readonly automations: AutomationRecord[];
    readonly connectors: { id: string; config: CliConfig }[];
}

export const listenerState = async (services: Pick<Services, "automations" | "capabilities">, provider: string): Promise<ListenerState> => {
    const [automations, capabilities] = await Promise.all([services.automations.list(), services.capabilities.list()]);
    return {
        automations: automations.filter(
            (automation) => automation.enabled && automation.trigger.kind === "listener" && automation.trigger.provider === provider,
        ),
        connectors: capabilities.flatMap((capability) =>
            capability.kind === "cli" && capability.config.provider === provider ? [{ id: capability.id, config: capability.config }] : [],
        ),
    };
};

// The reconcile feed as one extension reads it: only the connectors whose cli contribution that extension declares, so
// an extension naming another's provider as its listener is handed nobody else's credentials.
export const listenerStateOf = async (
    services: Pick<Services, "automations" | "capabilities"> & ExtensionHost,
    provider: string,
    extensionId: string,
): Promise<ListenerState> => {
    const [state, registry] = await Promise.all([listenerState(services, provider), contributionRegistry(services)]);
    return {
        ...state,
        connectors: state.connectors.filter((connector) => contributionFor(registry, "cli", connector.config)?.extension.id === extensionId),
    };
};

// Whether the gateway process is wanted: a connector alone keeps it up; an enabled automation alone keeps it polling.
// Actually connecting is the gateway's own stricter check; whether it can run at all is composed separately.
export const listenerProcessesDesired = (state: ListenerState): boolean => state.automations.length > 0 || state.connectors.length > 0;

// A listener provider belongs to exactly one enabled extension: the one whose gateway may read its connectors, fire its
// automations and report its status (listener.routes.ts), and the one the daemon hands outbound replies to
// (listener-deliver.ts). Two extensions naming the same provider are resolved by one rule, the same everywhere:
// - the declarer that also contributes the provider's connector card (`cli:<provider>`, as the contribution registry
//   resolves it) owns it;
// - else the first declarer in enumeration order (built-in, then git-installed, then workspace by folder name).
// Every other declaration is refused: its extension still loads, but its listener is not wired, and the refusal is a
// sentence on its row in the Extensions list.

export interface ListenerOwnership {
    // Provider to the id of the extension that owns its listener.
    readonly owners: ReadonlyMap<string, string>;
    // Extension id to why its listener declaration was refused.
    readonly refused: ReadonlyMap<string, string>;
}

// The rule itself, over a list already enumerated: `cardOwnerOf` names the extension the provider's connector card
// resolves to, if any.
export const resolveListenerOwners = (
    extensions: readonly InstalledExtension[],
    cardOwnerOf: (provider: string) => string | undefined,
): ListenerOwnership => {
    const declarers = new Map<string, InstalledExtension[]>();
    for (const extension of extensions) {
        const provider = extension.manifest.contributes?.listener?.provider;
        if (provider !== undefined) {
            declarers.set(provider, [...(declarers.get(provider) ?? []), extension]);
        }
    }
    const owners = new Map<string, string>();
    const refused = new Map<string, string>();
    for (const [provider, claims] of declarers) {
        const card = cardOwnerOf(provider);
        const owner = claims.find((extension) => extension.id === card) ?? claims[0];
        if (owner === undefined) {
            continue;
        }
        owners.set(provider, owner.id);
        const why = owner.id === card ? `it contributes the ${provider} connector card` : "it was installed first";
        for (const other of claims) {
            if (other !== owner) {
                refused.set(
                    other.id,
                    `Its listener for "${provider}" is refused: ${owner.id} already owns that provider's listener (${why}), and a provider has one listener.`,
                );
            }
        }
    }
    return { owners, refused };
};

// The rule over a given list of enabled extensions, with the card owner read off the contribution registry.
export const listenerOwnershipOf = async (host: ExtensionHost, extensions: readonly InstalledExtension[]): Promise<ListenerOwnership> => {
    const registry = await contributionRegistry(host);
    return resolveListenerOwners(extensions, (provider) => registry.get(contributionKey("cli", provider))?.extension.id);
};

// The rule over the enabled extensions as of now, from the contribution cache.
export const listenerOwnership = async (host: ExtensionHost): Promise<ListenerOwnership> =>
    listenerOwnershipOf(host, await cachedEnabledExtensions(host));
