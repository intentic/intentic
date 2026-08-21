import type { EndpointConfig } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "../capability.js";

/* A model API the user pointed us at. Ollama on the docker host, a vLLM across the network, a gateway. The
 * capability holds only where it is and how to talk to it; what it SERVES is asked of the server itself
 * (endpoint-catalog.ts), and what makes it drivable by the Claude Code harness is an entry in the bundled
 * translator's provider list, reconciled by the route after this handler stores the config.
 *
 * BOTH apply AND status ARE THE SAME PROBE, and it is deliberately not fatal. Adding an endpoint whose server
 * isn't up yet is the ordinary case, the user is standing up Ollama in another terminal, or hasn't pulled a
 * model into it, and refusing the add would throw away the configuration they just typed to punish them for the
 * order they did things in. So the entry is stored either way and the card carries the truth: this is exactly the
 * shape the docker capability uses for a pre-rebuild add.
 *
 * The count is the useful half of the message. "Connected" says nothing a user can act on; "3 models" versus "no
 * models" is the difference between a working endpoint and a server that is up but has nothing loaded, which is
 * the single most common way an Ollama install disappoints its owner. */
export const endpointHandler: CapabilityHandler = {
    // The one rotatable credential. The header block beside it is deliberately NOT the secret: it carries routing
    // metadata (a tenant id, a project header) that the owner has to be able to READ to diagnose a misrouted
    // endpoint, and a server with no auth at all is the ordinary case here.
    secret: (config) => ((config as EndpointConfig).apiKey !== undefined ? "apiKey" : undefined),
    // The URL and the protocol are what the card renders and what a user checks when a turn fails, so both
    // travel; the key becomes hasSecret. Headers travel too, see `secret` above on why they are not secret.
    echo: (config) => {
        const endpoint = config as EndpointConfig;
        return {
            baseUrl: endpoint.baseUrl,
            protocol: endpoint.protocol,
            ...(endpoint.headers !== undefined ? { headers: endpoint.headers } : {}),
            hasSecret: endpoint.apiKey !== undefined && endpoint.apiKey !== "",
        };
    },
    // The re-apply re-probes the server under the new name and stores its catalog there; this drops the old
    // name's, for the same reason `remove` does, a stale list left behind is what the next endpoint given that
    // name would inherit, and the translator's provider list is rebuilt from these.
    rename: { carry: async (ctx, from) => ctx.endpointModels.forget(from) },
    apply: async function* (ctx, id, config) {
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
            /* NOT an error, which is what this said until the free-trial card started wearing a red badge on a
             * fresh sandbox. "error" is the loudest word this column has and it accuses the OWNER of having
             * broken something; an endpoint publishing nothing is far more often a server still coming up, a
             * model nobody has pulled yet, or, for the trial, which the owner never added and cannot edit, a
             * decision made at the other end entirely. `pending` says the only thing that is actually known:
             * there is nothing to route yet, and it is worth a look. */
            return { state: "pending", detail: "no models yet" };
        }
        return { state: "active", detail: `${catalog.models.length} models` };
    },
    // The persisted catalog goes with the capability: leaving it behind would hand a stale model list to the next
    // endpoint given the same name, and the translator entry is rebuilt from these lists.
    remove: async (ctx, id) => {
        await ctx.endpointModels.forget(id);
    },
};
