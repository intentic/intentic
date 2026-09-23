import { instancesOf } from "@intentic/capability-catalog";
import type { CapabilityStatus } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { actorObserver, liveRequestRun } from "../agents/actor/card-offers.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { capabilityCtx } from "./capability.js";
import { type AskInstance, createCapabilityGate } from "./capability-offer.js";
import { connectableEntries } from "./connectable.js";
import { registry } from "./registry.js";

// The `capabilities` CLI's two routes: `connectable` lists entries this sandbox could connect (ids and names only, no
// config); `ask` parks the calling agent on an in-chat entry for the owner to decide (capability-offer.ts).

export const createCapabilityAskRoutes = (services: Services) => {
    const ctx = capabilityCtx(services);
    // Looks up an instance's status fresh each call; a deleted instance answers `inactive`.
    const statusOf = async (instance: AskInstance): Promise<CapabilityStatus> => {
        const entry = (await services.capabilities.list()).find((capability) => capability.id === instance.id);
        if (entry === undefined) {
            return { state: "inactive" };
        }
        return registry[entry.kind].status(ctx, entry.id, entry.config);
    };
    const gate = createCapabilityGate({
        entries: () => connectableEntries(services),
        list: () => services.capabilities.list(),
        status: statusOf,
        liveRun: liveRequestRun(services.conversations),
        observe: actorObserver(services.conversations),
        cards: services.cards,
    });
    return {
        connectable: async (c: Context<AppEnv>): Promise<Response> => {
            const [entries, capabilities] = await Promise.all([connectableEntries(services), services.capabilities.list()]);
            // Statuses are probed once for the whole manifest; `connected` means live, not merely added.
            const statuses = new Map(
                await Promise.all(
                    capabilities.map(
                        async (capability) => [capability.id, await registry[capability.kind].status(ctx, capability.id, capability.config)] as const,
                    ),
                ),
            );
            return c.json({
                entries: entries.map((entry) => {
                    const instances = instancesOf(entry, capabilities);
                    return {
                        entry: entry.id,
                        name: entry.name,
                        description: entry.description,
                        connected: instances.some((instance) => statuses.get(instance.id)?.state === "active"),
                    };
                }),
            });
        },
        ask: async (c: Context<AppEnv>): Promise<Response> => {
            let body: unknown;
            try {
                body = await c.req.json();
            } catch {
                return c.json({ error: { type: "invalid_request", message: 'the ask body must be JSON: {"entry":"…","why":"…"}' } }, 400);
            }
            const { entry, why } = (body ?? {}) as { entry?: unknown; why?: unknown };
            if (typeof entry !== "string" || entry === "") {
                return c.json({ error: { type: "invalid_request", message: "`entry` names the capability entry to ask for" } }, 400);
            }
            const answer = await gate.ask({
                entry,
                why: typeof why === "string" ? why : undefined,
                conversationId: c.req.header("x-intentic-conversation"),
                signal: c.req.raw.signal,
            });
            return c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType });
        },
    };
};
