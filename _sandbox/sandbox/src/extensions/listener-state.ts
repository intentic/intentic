import type { CliConfig } from "@intentic/sandbox-contract";
import type { AutomationRecord } from "../automations/automations-store.js";
import { contributionFor, contributionRegistry } from "../capabilities/contributions.js";
import type { Services } from "../composition.js";
import type { ExtensionHost } from "./installed-extensions.js";

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
