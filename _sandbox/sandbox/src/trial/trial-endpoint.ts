import { type Capability, TRIAL_ENDPOINT_ID, TRIAL_MODEL_ID } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { CompatEntry } from "../endpoints/endpoint-translator.js";
import type { Config } from "../env.config.js";
import type { PlatformTunnel } from "../platform/listeners/local-tunnel.js";
import type { TrialService } from "./trial.js";

// Synthetic capability laid over the store, never written to .intentic/config/capabilities.json: its "API key" is this
// sandbox's connect token, so an editable, persisted card would expose it and let a typo break the platform identity.
// Exists exactly while the platform's probe says the trial is on, no cleanup needed when it turns off.

// openai protocol rides the translator's compat list like any user endpoint. Base URL prefers the tunnel: the
// translator is a Go binary that verifies certificates, so a self-signed dev platform fails without it.
const trialBaseUrl = (config: Config, tunnel: PlatformTunnel): string => new URL("/trial/v1", tunnel.url() ?? config.platform.url).toString();

const trialCapability = (config: Config, tunnel: PlatformTunnel): Capability => ({
    id: TRIAL_ENDPOINT_ID,
    kind: "endpoint",
    config: {
        baseUrl: trialBaseUrl(config, tunnel),
        protocol: "openai",
        // Sandbox's connect token, spent as a bearer; the same credential already presented to /sandbox/announce.
        apiKey: config.connectToken,
    },
});

// Exists whenever a platform is configured, unlike the capability which needs the probe: configuration-based rendering
// keeps the table free of races with the translator's boot-time write. Undefined only with no platform or no token.
export const trialCompatEntry = (config: Config, tunnel: PlatformTunnel): CompatEntry | undefined => {
    if (config.platform.url === "" || config.connectToken === "") {
        return undefined;
    }
    return {
        name: TRIAL_ENDPOINT_ID,
        prefix: TRIAL_ENDPOINT_ID,
        "base-url": trialBaseUrl(config, tunnel),
        headers: {},
        "api-key-entries": [{ "api-key": config.connectToken }],
        models: [{ name: TRIAL_MODEL_ID, alias: TRIAL_MODEL_ID }],
    };
};

// Lays the trial over a store: reads see it, writes cannot touch it. upsert/remove refuse the reserved id rather than
// writing a shadow row that would outlive the platform's answer; remove answers false like any other absent id.
export const withTrialEndpoint = (store: CapabilitiesStore, config: Config, trial: TrialService, tunnel: PlatformTunnel): CapabilitiesStore => ({
    list: async () => {
        const entries = await store.list();
        // A hand-edited entry with the reserved id wins over the synthetic one.
        if (!trial.available() || entries.some((entry) => entry.id === TRIAL_ENDPOINT_ID)) {
            return entries;
        }
        return [...entries, trialCapability(config, tunnel)];
    },
    get: async (id) => {
        const existing = await store.get(id);
        if (existing !== undefined || id !== TRIAL_ENDPOINT_ID || !trial.available()) {
            return existing;
        }
        return trialCapability(config, tunnel);
    },
    upsert: async (capability) => {
        if (capability.id === TRIAL_ENDPOINT_ID) {
            throw new Error(`"${TRIAL_ENDPOINT_ID}" is provisioned by intentic and cannot be edited`);
        }
        await store.upsert(capability);
    },
    remove: async (id) => (id === TRIAL_ENDPOINT_ID ? false : store.remove(id)),
});
