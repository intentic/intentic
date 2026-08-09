import { endpointsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type EndpointsRoutesDeps = Pick<Services, "capabilities" | "endpointModels" | "trial">;

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
        /* What is left of today's free trial. Re-probed on every read rather than served from the boot cache:
         * the number's whole job is to be right in the picker after the message the user just sent, and the
         * allowance is spent platform-side where this daemon cannot observe it. The probe swallows its own
         * failure, so an unreachable platform answers with the last known figures instead of an error.
         *
         * A sandbox with no trial answers `available: false` with zeroes rather than a 404 — "you have no trial"
         * is the ordinary state for most sandboxes, and a picker should not have to read an error to learn it. */
        trial: i.trial.handler(async () => {
            await services.trial.refresh();
            const status = services.trial.status();
            if (!services.trial.available() || status === undefined) {
                return { available: false, allowance: 0, used: 0, remaining: 0 };
            }
            return { available: true, allowance: status.allowance, used: status.used, remaining: status.remaining, resetsAt: status.resetsAt };
        }),
    };
};
