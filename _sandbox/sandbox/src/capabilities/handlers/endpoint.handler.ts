import { isVaulted } from "@intentic/sandbox-contract/policy/capability-secrets";
import type { EndpointConfig } from "@intentic/sandbox-contract/schemas/capabilities";
import { opt } from "../../opt.js";
import type { CapabilityHandler } from "../capability.js";

// A key long enough that its last four characters say which key it is without saying much of it: every vendor's key is
// several times this. A short one (a local server's password) is not hinted at all.
const HINTED_KEY_LENGTH = 20;

// The last four characters, which is how a vendor's own console names a key and all a reader needs to tell two apart (a
// key found on the owner's computer is offered the same way, migrations/provider-keys.ts). Never the vault's marker, which
// a read that bypassed the vault would hand in.
const keyHintOf = (apiKey: string | undefined): string | undefined =>
    apiKey === undefined || isVaulted(apiKey) || apiKey.trim().length < HINTED_KEY_LENGTH ? undefined : apiKey.trim().slice(-4);

// A model API the user pointed us at (Ollama, vLLM, a gateway); this holds only where it is and how to reach it. apply
// and status are the same probe, deliberately not fatal: the server being down yet is ordinary, so the config is stored
// either way. The model count is the useful signal, not "connected".
export const endpointHandler: CapabilityHandler = {
    // The one rotatable credential; the header beside it is routing metadata the owner must read, not a secret.
    secret: (config) => ((config as EndpointConfig).apiKey !== undefined ? "apiKey" : undefined),
    // URL and protocol travel as-is (what the entry renders, what a user checks on failure); headers travel too; the key
    // becomes hasSecret, and its last four characters where it is long enough to spare them (the row a provider's card
    // draws for it reads "API key ··a3f9").
    echo: (config) => {
        const endpoint = config as EndpointConfig;
        return {
            baseUrl: endpoint.baseUrl,
            protocol: endpoint.protocol,
            ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
            hasSecret: endpoint.apiKey !== undefined && endpoint.apiKey !== "",
            ...opt("keyHint", keyHintOf(endpoint.apiKey)),
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
                message: `Stored ${id}, it published no models yet. Check the server is running at that URL and has a model loaded; the entry re-probes on every visit.`,
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
