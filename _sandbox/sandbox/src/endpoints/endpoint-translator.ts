import { type Capability, type EndpointConfig, TRIAL_ENDPOINT_ID } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { cliProxyManagementUrl } from "../agent/providers/translator.js";
import { trialCompatEntry } from "../trial/trial-endpoint.js";
import { parseHeaders, versionedBase } from "./endpoint-config.js";
import { endpointConfigOf } from "./local-model.js";

// An OpenAI-compatible endpoint expressed as a CLIProxyAPI provider entry, reusing the translator already in the image
// instead of a new adapter path. `prefix` namespaces models across endpoints as `<capability id>/<model>`. The rendered
// config is the source of truth; the Management API PUT only pushes it to a running proxy without a restart.

// Addresses a model as `<capability id>/<model>`; the credential resolver must parse it the same way.
export const endpointModelId = (id: string, model: string): string => `${id}/${model}`;

export interface CompatModel {
    readonly name: string;
    readonly alias: string;
}

export interface CompatEntry {
    readonly name: string;
    readonly prefix: string;
    readonly "base-url": string;
    // Empty when no extra headers are declared; never absent, so render can omit the block outright.
    readonly headers: Record<string, string>;
    readonly "api-key-entries": readonly { readonly "api-key": string }[];
    readonly models: readonly CompatModel[];
}

// Only openai-protocol endpoints ride the translator: anthropic-protocol goes direct, localmodel derives its own entry.
// Trial is excluded here since it uses a static entry (trialCompatEntry), independent of the probe.
export const translatedEndpoints = (capabilities: readonly Capability[]): { id: string; config: EndpointConfig }[] =>
    capabilities.flatMap((capability) => {
        const config = capability.id === TRIAL_ENDPOINT_ID ? undefined : endpointConfigOf(capability);
        return config !== undefined && config.protocol === "openai" ? [{ id: capability.id, config }] : [];
    });

// One entry per endpoint, models from the live catalog; an endpoint with no known models is still emitted, empty.
// `api-key-entries` always holds exactly one entry (possibly empty), CLIProxyAPI's credential pool for the provider.
export const endpointCompatEntries = async (services: Services): Promise<CompatEntry[]> => {
    const endpoints = translatedEndpoints(await services.capabilities.list());
    const entries = await Promise.all(
        endpoints.map(async ({ id, config }) => {
            const catalog = await services.endpointModels.models(id, config).catch(() => ({ models: [], default: "" }));
            return {
                name: id,
                prefix: id,
                "base-url": versionedBase(config.baseUrl),
                headers: parseHeaders(config.headers),
                "api-key-entries": [{ "api-key": config.apiKey ?? "" }],
                models: catalog.models.map((model) => ({ name: model.id, alias: model.id })),
            };
        }),
    );
    // Trial entry is added unconditionally, independent of the probe-gated capability the picker reads.
    const trial = trialCompatEntry(services.config, services.platformTunnel);
    return trial === undefined ? entries : [...entries, trial];
};

// The `openai-compatibility:` block of the rendered config, or "" when there is nothing to serve; values go through
// JSON.stringify for valid YAML double-quoted scalars.
export const compatYaml = (entries: readonly CompatEntry[]): string => {
    if (entries.length === 0) {
        return "";
    }
    const lines = ["openai-compatibility:"];
    for (const entry of entries) {
        lines.push(`  - name: ${JSON.stringify(entry.name)}`, `    prefix: ${JSON.stringify(entry.prefix)}`);
        lines.push(`    base-url: ${JSON.stringify(entry["base-url"])}`);
        const headers = Object.entries(entry.headers);
        if (headers.length > 0) {
            lines.push("    headers:");
            for (const [name, value] of headers) {
                lines.push(`      ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
            }
        }
        lines.push("    api-key-entries:");
        for (const key of entry["api-key-entries"]) {
            lines.push(`      - api-key: ${JSON.stringify(key["api-key"])}`);
        }
        // `models:` with no items parses as null in YAML; `[]` must be written explicitly for the empty list.
        lines.push(entry.models.length === 0 ? "    models: []" : "    models:");
        for (const model of entry.models) {
            lines.push(`      - name: ${JSON.stringify(model.name)}`, `        alias: ${JSON.stringify(model.alias)}`);
        }
    }
    return lines.join("\n");
};

// Pushes current entries to a running proxy so a UI change takes effect without a restart; PUT replaces the whole list
// since the daemon owns every entry. Best-effort: failures are swallowed since the next render carries the same
// entries.
export const syncEndpointCompat = async (services: Services): Promise<void> => {
    if (services.config.translator.url === "") {
        return;
    }
    const entries = await endpointCompatEntries(services);
    const response = await fetch(`${cliProxyManagementUrl(services.config)}/openai-compatibility`, {
        method: "PUT",
        headers: { authorization: `Bearer ${services.config.translator.token}`, "content-type": "application/json" },
        body: JSON.stringify(entries),
    }).catch((error: unknown) => {
        services.logger.warn({ err: error }, "translator: endpoint sync could not reach the management api");
        return undefined;
    });
    if (response !== undefined && !response.ok) {
        services.logger.warn({ status: response.status }, "translator: endpoint sync rejected");
    }
};
