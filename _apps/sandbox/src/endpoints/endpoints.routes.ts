import { endpointsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type EndpointsRoutesDeps = Pick<Services, "capabilities" | "endpointModels">;

// The picker catalog for one `endpoint` capability. Unlike the four fixed provider routes this one resolves its
// subject first: the id in the path names a capability, and an id that names none is a NOT_FOUND rather than an
// empty list — "this endpoint was removed" and "this endpoint publishes nothing" are different problems with
// different fixes, and a blank catalog cannot tell them apart.
export const createEndpointsRoutes = (services: EndpointsRoutesDeps) => {
    const i = implement(endpointsContract).$context<OrpcContext>();
    return {
        models: i.models.handler(async ({ input }) => {
            const capability = await services.capabilities.get(input.id);
            if (capability === undefined || capability.kind !== "endpoint") {
                throw new ORPCError("NOT_FOUND", { message: "no endpoint with that id" });
            }
            return services.endpointModels.models(capability.id, capability.config);
        }),
    };
};
