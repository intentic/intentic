import {
    type AgentHarness,
    type Capability,
    capabilitiesOf,
    endpointIdOf,
    endpointProvider,
    type PrivacyProvider,
    type PrivacyShieldPolicy,
    PROVIDER_SPECS,
    providerLabel,
} from "@intentic/sandbox-contract";

// Who may read personal data as it is. The owner names trusted providers; a model running on this machine is trusted
// whatever the list says, since nothing it reads leaves. Everything else is untrusted while the shield is on, the free
// trial included: it passes through Intentic's servers to a vendor the owner never chose.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

const loopbackUrl = (url: string): boolean => {
    try {
        return LOOPBACK_HOSTS.has(new URL(url).hostname);
    } catch {
        // allow(silent-catch): an address that does not parse can't be shown to stay on this machine.
        return false;
    }
};

// Whether a provider is a model this machine serves: a local-model card, or an endpoint the owner pointed at loopback.
export const isLocalProvider = (provider: string, capabilities: readonly Capability[]): boolean => {
    const id = endpointIdOf(provider);
    if (id === undefined) {
        return false;
    }
    const capability = capabilities.find((entry) => entry.id === id);
    if (capability?.kind === "localmodel") {
        return true;
    }
    return capability?.kind === "endpoint" && loopbackUrl(capability.config.baseUrl);
};

export const isTrustedProvider = (policy: Pick<PrivacyShieldPolicy, "trusted">, provider: string, capabilities: readonly Capability[]): boolean =>
    isLocalProvider(provider, capabilities) || policy.trusted.includes(provider);

// Whether a turn on this provider and harness can be put behind the gateway at all.
export const shieldableRuntime = (provider: string, harness: AgentHarness): boolean => capabilitiesOf(provider, harness).privacy === "gateway";

// Every provider this sandbox could run a turn on, for the trusted list: the native ones, then each endpoint, local
// model and agent the owner connected.
export const privacyProviders = (capabilities: readonly Capability[]): PrivacyProvider[] => {
    const shieldable = (provider: string): boolean => shieldableRuntime(provider, "native") || shieldableRuntime(provider, "claude-code");
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
