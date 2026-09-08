import { endpointsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { endpointConfigOf } from "./local-model.js";

export type EndpointsRoutesDeps = Pick<Services, "capabilities" | "endpointModels" | "trial">;

// The picker catalog for one endpoint-minting capability; unlike the four fixed provider routes it resolves its subject
// first, so an id naming no capability is NOT_FOUND rather than an empty list.
export const createEndpointsRoutes = (services: EndpointsRoutesDeps) => {
    const i = implement(endpointsContract).$context<OrpcContext>();
    return {
        models: i.models.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            const config = capability === undefined ? undefined : endpointConfigOf(capability);
            if (capability === undefined || config === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no endpoint with that id" });
            }
            return services.endpointModels.models(capability.id, config);
        }),
        // Re-probed on every read rather than cached, so the number reflects the message just sent; probe failure falls
        // back to the last known figures. No trial returns `available: false` with zeroes, not a 404.
        trial: i.trial.handler(async () => {
            await services.trial.refresh();
            const status = services.trial.status();
            if (!services.trial.available() || status === undefined) {
                return { available: false, allowance: 0, used: 0, remaining: 0, health: "unknown" as const };
            }
            return {
                available: true,
                allowance: status.allowance,
                used: status.used,
                remaining: status.remaining,
                health: status.health,
                resetsAt: status.resetsAt,
                ...(status.retryAt === undefined ? {} : { retryAt: status.retryAt }),
                ...(status.servedModel === undefined ? {} : { servedModel: status.servedModel }),
            };
        }),
    };
};
