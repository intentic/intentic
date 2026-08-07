import type { CliConfig } from "@intentic/sandbox-contract";
import type { AutomationRecord } from "../automations/automations-store.js";
import type { Services } from "../composition.js";

// A provider's listener state: the reconcile feed its gateway process polls (via /listeners/:provider/state)
// AND the daemon-side spawn gate for that gateway (extension-processes.ts) — one computation, so the two can
// never drift. Connector configs ride with their secrets: the gateway needs the bot token to connect.
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

// Whether the provider's gateway process is WANTED: a connector alone keeps it up (its loopback control
// surface serves the voice CLI), an enabled automation alone keeps it polling for a connector to arrive.
// Actually CONNECTING to the provider stays the gateway's own stricter predicate (automations AND a non-empty
// token) — this only gates the process's existence. Whether a wanted gateway CAN run is the other half of the
// spawn gate and is composed beside this one (extension-processes.ts): its runtime has to be in the image,
// which on a core image it is not. That half is deliberately not in ListenerState — this shape is also the
// feed a live gateway polls, and there is no live gateway to tell about its own absence.
export const listenerProcessesDesired = (state: ListenerState): boolean => state.automations.length > 0 || state.connectors.length > 0;
