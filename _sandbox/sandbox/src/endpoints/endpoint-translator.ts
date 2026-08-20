import { type Capability, type EndpointConfig, TRIAL_ENDPOINT_ID } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { cliProxyManagementUrl } from "../agent/translator.js";
import { trialCompatEntry } from "../trial/trial-endpoint.js";
import { parseHeaders, versionedBase } from "./endpoint-config.js";

/* AN OPENAI-COMPATIBLE ENDPOINT, EXPRESSED AS A CLIPROXYAPI PROVIDER, the whole of what makes a self-configured
 * model API drivable by a harness that speaks only the Anthropic Messages API.
 *
 * No new adapter, no second turn path: the translator is already in the image and already re-serves four
 * subscription providers this way, and its `openai-compatibility` list is the seam for arbitrary upstreams. An
 * endpoint becomes one entry in that list, and from there it is indistinguishable to the rest of the daemon from
 * a routed provider, same HarnessEndpoint, same ANTHROPIC_BASE_URL, same alias pinning.
 *
 * THE ENTRY IS ALSO THE ROUTING TABLE. A model the entry does not declare is refused with "unknown provider for
 * model", so the declared list is not documentation, it is the set of models the endpoint can actually serve,
 * which is why it is rebuilt from the live catalog rather than written once at add time.
 *
 * `prefix` is what lets several endpoints coexist: two servers both publishing `qwen3-coder` would otherwise
 * collide on one global id. Every model is addressed as `<capability id>/<model>` (endpointModelId).
 *
 * TWO WRITE PATHS, AND BOTH ARE REQUIRED. The Management API's PUT is how a change reaches a running proxy
 * without a restart, but startTranslator re-renders config.yaml from scratch on every spawn AND on every rung
 * of its restart ladder, so anything that lived only in the proxy's memory is erased by the next crash-restart.
 * So the config render is the source of truth and the PUT is the live update; they carry the same entries. */

// What a turn hands the translator to reach one endpoint's model, the other half of the `prefix` below, and the
// reason it lives here rather than beside the credential resolver that sends it: the two have to agree, and this
// is the module that decides how an endpoint is addressed.
export const endpointModelId = (id: string, model: string): string => `${id}/${model}`;

export interface CompatModel {
    readonly name: string;
    readonly alias: string;
}

export interface CompatEntry {
    readonly name: string;
    readonly prefix: string;
    readonly "base-url": string;
    // Always present, empty when the user declared none, the empty record IS "no extra headers", so there is no
    // absent state to distinguish and the render simply omits the block.
    readonly headers: Record<string, string>;
    readonly "api-key-entries": readonly { readonly "api-key": string }[];
    readonly models: readonly CompatModel[];
}

// Only openai-protocol endpoints ride the translator. An anthropic-protocol one already speaks the harness's own
// wire, so it is pointed at directly (harness-credentials.ts) and has no business in this list. The trial is
// excluded here because its entry is STATIC (trialCompatEntry, appended below): deriving it from the capability
// list would tie the routing table back to the availability probe's timing, which is the fresh-install race this
// split exists to end — and when the probe HAS answered, the layered capability would mint a second entry on the
// same prefix.
export const translatedEndpoints = (capabilities: readonly Capability[]): { id: string; config: EndpointConfig }[] =>
    capabilities.flatMap((capability) =>
        capability.kind === "endpoint" && capability.config.protocol === "openai" && capability.id !== TRIAL_ENDPOINT_ID
            ? [{ id: capability.id, config: capability.config }]
            : [],
    );

/* One entry per endpoint, its models taken from the live catalog (which falls back to the last list this
 * endpoint answered with, see endpoint-catalog.ts for why that rung has to exist for this caller in particular).
 *
 * An endpoint with no known models is emitted anyway, with an empty model list. It routes nothing, which is
 * correct, but it keeps the provider present and its failure legible as "this endpoint has published no models"
 * rather than as a provider that silently vanished from the picker while the user was looking at its card.
 *
 * `api-key-entries` always carries exactly one entry, empty string included: it is CLIProxyAPI's credential pool
 * for the provider, and an entry with no pool has no credential to select. An unauthenticated model server (the
 * ordinary case for one on the docker host) then receives an empty bearer, which it ignores. */
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
    /* The trial's entry, ALWAYS, on any platform-connected sandbox — never derived from the probe-gated
     * capability the picker reads. Routability is a constant of the sandbox's configuration; whether the trial
     * is OFFERED stays the probe's business (trial-endpoint.ts has the whole argument). */
    const trial = trialCompatEntry(services.config, services.platformTunnel);
    return trial === undefined ? entries : [...entries, trial];
};

// The `openai-compatibility:` block of the rendered config, or "" when there is nothing to serve. Written as text
// like the rest of renderConfig, values go through JSON.stringify, which emits valid YAML double-quoted scalars.
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
        // An empty list must still be spelled out: `models:` with nothing under it parses as null, where `[]` is
        // the empty list the proxy expects.
        lines.push(entry.models.length === 0 ? "    models: []" : "    models:");
        for (const model of entry.models) {
            lines.push(`      - name: ${JSON.stringify(model.name)}`, `        alias: ${JSON.stringify(model.alias)}`);
        }
    }
    return lines.join("\n");
};

/* Push the current entries to a RUNNING proxy, so an endpoint added or edited from the UI serves turns without
 * waiting for a restart. The Management API replaces the whole list (a bare JSON array, the wrapper shape the
 * GET answers with is rejected), which is right because the daemon owns every entry in it: nothing else writes
 * this list, so a full replace can never clobber a stranger's row.
 *
 * Best-effort and non-throwing, like every other translator call: the proxy may be mid-restart or absent (a bare
 * dev run bakes no translator), and the config render at its next start carries the same entries anyway. */
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
