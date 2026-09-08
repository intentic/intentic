import type { EndpointConfig } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "../capability.js";

// A model API the user pointed us at (Ollama, vLLM, a gateway); this holds only where it is and how to reach it. apply
// and status are the same probe, deliberately not fatal: the server being down yet is ordinary, so the config is stored
// either way. The model count is the useful signal, not "connected".
export const endpointHandler: CapabilityHandler = {
    // The one rotatable credential; the header beside it is routing metadata the owner must read, not a secret.
    secret: (config) => ((config as EndpointConfig).apiKey !== undefined ? "apiKey" : undefined),
    // URL and protocol travel as-is (what the card renders, what a user checks on failure); headers travel too; the key
    // becomes hasSecret.
    echo: (config) => {
        const endpoint = config as EndpointConfig;
        return {
            baseUrl: endpoint.baseUrl,
            protocol: endpoint.protocol,
            ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
            hasSecret: endpoint.apiKey !== undefined && endpoint.apiKey !== "",
        };
    },
    // Drops the old name's catalog: left behind, it would be inherited by the next endpoint given that name. The
    // translator's provider list rebuilds from these.
    rename: { carry: async (ctx, from) => ctx.endpointModels.forget(from) },
    async *apply(ctx, id, config) {
        const catalog = await ctx.endpointModels.models(id, config as EndpointConfig);
        if (catalog.models.length === 0) {
            yield {
                kind: "log",
                message: `Stored ${id}, it published no models yet. Check the server is running at that URL and has a model loaded; the card re-probes on every visit.`,
            };
            return;
        }
        yield {
            kind: "log",
            message: `${id} serves ${catalog.models.length} model${catalog.models.length === 1 ? "" : "s"} (${catalog.default} by default), it appears as a provider in the chat picker.`,
        };
    },
    status: async (ctx, id, config) => {
        const catalog = await ctx.endpointModels.models(id, config as EndpointConfig);
        if (catalog.models.length === 0) {
            // Pending, not error: nothing published is usually a server still starting, not the owner's fault.
            return { state: "pending", detail: "no models yet" };
        }
        return { state: "active", detail: `${catalog.models.length} models` };
    },
    // Drops the persisted catalog too, so a later endpoint with the same name doesn't inherit a stale model list.
    remove: async (ctx, id) => {
        await ctx.endpointModels.forget(id);
    },
};
