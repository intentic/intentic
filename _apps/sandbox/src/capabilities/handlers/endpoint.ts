import type { EndpointConfig } from "@intentic/sandbox-contract";
import type { CapabilityHandler } from "../capability.js";

/* A model API the user pointed us at — Ollama on the docker host, a vLLM across the network, a gateway. The
 * capability holds only where it is and how to talk to it; what it SERVES is asked of the server itself
 * (endpoint-catalog.ts), and what makes it drivable by the Claude Code harness is an entry in the bundled
 * translator's provider list, reconciled by the route after this handler stores the config.
 *
 * BOTH apply AND status ARE THE SAME PROBE, and it is deliberately not fatal. Adding an endpoint whose server
 * isn't up yet is the ordinary case — the user is standing up Ollama in another terminal, or hasn't pulled a
 * model into it — and refusing the add would throw away the configuration they just typed to punish them for the
 * order they did things in. So the entry is stored either way and the card carries the truth: this is exactly the
 * shape the docker capability uses for a pre-rebuild add.
 *
 * The count is the useful half of the message. "Connected" says nothing a user can act on; "3 models" versus "no
 * models" is the difference between a working endpoint and a server that is up but has nothing loaded — which is
 * the single most common way an Ollama install disappoints its owner. */
export const endpointHandler: CapabilityHandler = {
    apply: async function* (ctx, id, config) {
        const catalog = await ctx.endpointModels.models(id, config as EndpointConfig);
        if (catalog.models.length === 0) {
            yield {
                kind: "log",
                message: `Stored ${id} — it published no models yet. Check the server is running at that URL and has a model loaded; the card re-probes on every visit.`,
            };
            return;
        }
        yield {
            kind: "log",
            message: `${id} serves ${catalog.models.length} model${catalog.models.length === 1 ? "" : "s"} (${catalog.default} by default) — it appears as a provider in the chat picker.`,
        };
    },
    status: async (ctx, id, config) => {
        const catalog = await ctx.endpointModels.models(id, config as EndpointConfig);
        if (catalog.models.length === 0) {
            return { state: "error", detail: "no models published" };
        }
        return { state: "active", detail: `${catalog.models.length} models` };
    },
    // The persisted catalog goes with the capability: leaving it behind would hand a stale model list to the next
    // endpoint given the same name, and the translator entry is rebuilt from these lists.
    remove: async (ctx, id) => {
        await ctx.endpointModels.forget(id);
    },
};
