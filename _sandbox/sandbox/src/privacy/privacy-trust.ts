import type { AgentHarness } from "@intentic/sandbox-contract/schemas/agent";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import {
    capabilitiesOf,
    endpointIdOf,
    endpointProvider,
    loopsOf,
    providerLabel,
    TRIAL_ENDPOINT_ID,
} from "@intentic/sandbox-contract/models/agent-catalog";
import type { PrivacyProvider } from "@intentic/sandbox-contract/schemas/privacy";
import { type PrivacyRoute, turnRoute } from "@intentic/sandbox-contract/schemas/privacy-egress";
import { PROVIDER_SPECS } from "@intentic/sandbox-contract/models/provider-specs";

// What the shield's verdict (privacy-egress.ts) needs to know of this sandbox: which providers are models this machine
// serves, which nothing they read leaves, and how a runtime's bytes reach its provider. Everything else is untrusted
// unless the owner says so, the free trial included: it passes through Intentic's servers to a vendor the owner never
// chose.

// Loopback, and the computer that runs this sandbox's container: Docker names it host.docker.internal for the container
// (the runner adds it as host-gateway), so Ollama or LM Studio on the owner's own PC is reached there. Its traffic
// stops at the machine the sandbox already runs on, the same promise loopback makes. Only for whom a model may read: the
// agent's own shell commands still treat that name as the network (command-classes.ts).
const THIS_MACHINE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);

const onThisMachine = (url: string): boolean => {
    try {
        return THIS_MACHINE_HOSTS.has(new URL(url).hostname);
    } catch {
        // allow(silent-catch): an address that does not parse can't be shown to stay on this machine.
        return false;
    }
};

// Whether a provider is a model this machine serves: a local-model card, or an endpoint the owner pointed at loopback or
// at the computer hosting the container.
// Never the free trial, whatever its address: it reaches Intentic's platform through a tunnel that listens on loopback
// (src/trial/trial-endpoint.ts), so its base URL reads as local while every request leaves for a vendor the owner never
// chose. Only a platform run on this machine for development would keep it here, and even that one relays to the vendor.
export const isLocalProvider = (provider: string, capabilities: readonly Capability[]): boolean => {
    const id = endpointIdOf(provider);
    if (id === undefined || id === TRIAL_ENDPOINT_ID) {
        return false;
    }
    const capability = capabilities.find((entry) => entry.id === id);
    if (capability?.kind === "localmodel") {
        return true;
    }
    return capability?.kind === "endpoint" && onThisMachine(capability.config.baseUrl);
};

// How a turn on this provider and harness reaches its provider: through the gateway, through the runtime's own hooks
// (agent-runtimes.ts `privacy`), or past both, which is the only runtime the shield refuses for what it is.
export const runtimeRoute = (provider: string, harness: AgentHarness): PrivacyRoute => turnRoute(capabilitiesOf(provider, harness).privacy);

// Every provider this sandbox could run a turn on, for the trusted list: the native ones, then each endpoint, local
// model and agent the owner connected.
export const privacyProviders = (capabilities: readonly Capability[]): PrivacyProvider[] => {
    const shieldable = (provider: string): boolean => loopsOf(provider).some((loop) => runtimeRoute(provider, loop) !== "runtime");
    const natives = PROVIDER_SPECS.map((spec) => ({ id: spec.id, label: spec.label, shieldable: shieldable(spec.id), local: false }));
    const connected = capabilities.flatMap((capability): PrivacyProvider[] => {
        if (capability.kind === "endpoint" || capability.kind === "localmodel") {
            const id = endpointProvider(capability.id);
            return [
                {
                    id,
                    label: providerLabel(id) === id ? capability.id : providerLabel(id),
                    shieldable: true,
                    local: isLocalProvider(id, capabilities),
                },
            ];
        }
        if (capability.kind === "agent") {
            return [{ id: capability.id, label: capability.config.name ?? capability.id, shieldable: shieldable(capability.id), local: false }];
        }
        return [];
    });
    const seen = new Set<string>();
    return [...natives, ...connected].filter((entry) => {
        if (seen.has(entry.id)) {
            return false;
        }
        seen.add(entry.id);
        return true;
    });
};
