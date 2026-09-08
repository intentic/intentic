import { instancesOf } from "@intentic/capability-catalog";
import type { CapabilityStatus } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { liveCardRun } from "../agent/run/offer-card.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { capabilityCtx } from "./capability.js";
import { type AskInstance, createCapabilityGate } from "./capability-offer.js";
import { connectableCards } from "./connectable.js";
import { registry } from "./registry.js";

// The `capabilities` CLI's two routes: `connectable` lists cards this sandbox could connect (ids and names only, no
// config); `ask` parks the calling agent on an in-chat card for the owner to decide (capability-offer.ts).

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
        cards: () => connectableCards(services),
        list: () => services.capabilities.list(),
        status: statusOf,
        liveRun: liveCardRun,
        observe: services.agents.observe,
    });
    return {
        connectable: async (c: Context<AppEnv>): Promise<Response> => {
            const [cards, capabilities] = await Promise.all([connectableCards(services), services.capabilities.list()]);
            // Statuses are probed once for the whole manifest; `connected` means live, not merely added.
            const statuses = new Map(
                await Promise.all(
                    capabilities.map(
                        async (capability) => [capability.id, await registry[capability.kind].status(ctx, capability.id, capability.config)] as const,
                    ),
                ),
            );
            return c.json({
                cards: cards.map((card) => {
                    const instances = instancesOf(card, capabilities);
                    return {
                        card: card.id,
                        name: card.name,
                        description: card.description,
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
                return c.json({ error: { type: "invalid_request", message: 'the ask body must be JSON: {"card":"…","why":"…"}' } }, 400);
            }
            const { card, why } = (body ?? {}) as { card?: unknown; why?: unknown };
            if (typeof card !== "string" || card === "") {
                return c.json({ error: { type: "invalid_request", message: "`card` names the capability card to ask for" } }, 400);
            }
            const answer = await gate.ask({
                card,
                why: typeof why === "string" ? why : undefined,
                conversationId: c.req.header("x-intentic-conversation"),
                signal: c.req.raw.signal,
            });
            return c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType });
        },
    };
};
