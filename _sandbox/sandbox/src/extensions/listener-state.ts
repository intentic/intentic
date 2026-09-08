import type { CliConfig } from "@intentic/sandbox-contract";
import type { AutomationRecord } from "../automations/automations-store.js";
import type { Services } from "../composition.js";

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

// Whether the gateway process is wanted: a connector alone keeps it up; an enabled automation alone keeps it polling.
// Actually connecting is the gateway's own stricter check; whether it can run at all is composed separately.
export const listenerProcessesDesired = (state: ListenerState): boolean => state.automations.length > 0 || state.connectors.length > 0;
