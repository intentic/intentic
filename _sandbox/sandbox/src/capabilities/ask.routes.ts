import { instancesOf } from "@intentic-app/capability-catalog";
import type { CapabilityStatus } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { soleLiveConversation, turnRunOf } from "../agent/turn-runs.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { capabilityCtx } from "./capability.js";
import { type AskInstance, createCapabilityGate } from "./capability-offer.js";
import { connectableCards } from "./connectable.js";
import { registry } from "./registry.js";

/* The `capabilities` CLI's two routes, the agent-facing half of the setup gate (capability-offer.ts).
 *
 * `connectable` is discovery: every card this sandbox could connect (the same merge the web's "+" grid
 * renders), each with whether it already is, what lets the agent name a real card instead of guessing, and
 * makes "is X available?" a read instead of a question for the owner. Card ids and names only, never config:
 * the agent grant may reach this precisely because nothing credential-shaped is in the answer.
 *
 * `ask` parks the calling agent on an in-chat card the owner decides, see the gate module for the whole
 * consent story. Both are reached with the per-boot agent token (auth/grants.ts), like `services`. */

export const createCapabilityAskRoutes = (services: Services) => {
    const ctx = capabilityCtx(services);
    // One instance's live status, looked up fresh so a probe never runs against a stale config, and answered
    // `inactive` for an instance deleted mid-watch, which reads correctly as "not connected".
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
        liveRun: (conversationId) => {
            const id = conversationId ?? soleLiveConversation();
            const run = id === undefined ? undefined : turnRunOf(id);
            return id === undefined || run === undefined || run.done ? undefined : { conversationId: id, push: (event) => run.push(event) };
        },
        observe: (conversationId, event) => services.agents.observe(conversationId, event),
    });
    return {
        connectable: async (c: Context<AppEnv>): Promise<Response> => {
            const [cards, capabilities] = await Promise.all([connectableCards(services), services.capabilities.list()]);
            // Statuses probed once for the whole manifest (the Capabilities page pays the same on every load),
            // so "connected" means live, not merely added, the difference the agent acts on.
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
