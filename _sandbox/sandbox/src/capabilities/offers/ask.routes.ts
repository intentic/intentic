import { instancesOf } from "@intentic/capability-catalog";
import type { CapabilityConnectable } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { capabilityCtx } from "../capability.js";
import { connectableEntries } from "./connectable.js";
import { capabilityRecommendations } from "./recommend.js";
import { registry } from "../registry.js";

// The `capabilities list` door: every entry this sandbox could connect (ids and names only, never config), which are
// live, and what the workspace itself looks like it wants, with the file or remote that says so. Asking for one is the
// needs door's (needs/needs.routes.ts), which answers for the asking turn rather than for the sandbox.

export const createCapabilityAskRoutes = (services: Services) => {
    const ctx = capabilityCtx(services);
    return {
        connectable: async (c: Context<AppEnv>): Promise<Response> => {
            const [entries, capabilities, dismissed] = await Promise.all([
                connectableEntries(services),
                services.capabilities.list(),
                services.capabilityDismissals.list(),
            ]);
            // Statuses are probed once for the whole manifest; `connected` means live, not merely added.
            const [statuses, recommendations] = await Promise.all([
                Promise.all(
                    capabilities.map(
                        async (capability) => [capability.id, await registry[capability.kind].status(ctx, capability.id, capability.config)] as const,
                    ),
                ).then((pairs) => new Map(pairs)),
                capabilityRecommendations(services.workspace.root, capabilities, dismissed),
            ]);
            const answer: CapabilityConnectable = {
                entries: entries.map((entry) => {
                    const instances = instancesOf(entry, capabilities);
                    return {
                        entry: entry.id,
                        name: entry.name,
                        description: entry.description,
                        connected: instances.some((instance) => statuses.get(instance.id)?.state === "active"),
                    };
                }),
                // The scan's evidence verbatim, so an agent can check the claim before asking for it.
                suggested: recommendations.map((recommendation) => ({
                    entry: recommendation.entry,
                    claim: recommendation.reason,
                    evidence: recommendation.evidence,
                })),
            };
            return c.json(answer);
        },
    };
};
