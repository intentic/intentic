import { endpointsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { localModelFit } from "./local-model-fit.js";
import { localModelPrefetch, localModelPrefetchStatus } from "./local-model-weights.js";
import { endpointConfigOf } from "./local-model.js";

export type EndpointsRoutesDeps = Pick<Services, "capabilities" | "endpointModels" | "trial" | "workspace">;

// How long a read waits on the platform before answering with the last known figures; a healthy platform answers well
// inside it, and a slow one must not hold the chat's account gate that awaits this read.
const TRIAL_READ_WAIT_MS = 3_000;

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
        // Re-probed on every read rather than cached, so the number reflects the message just sent; a probe that fails
        // or outlasts the wait falls back to the last known figures. No trial returns `available: false` with zeroes,
        // not a 404.
        trial: i.trial.handler(async () => {
            await services.trial.refresh({ withinMs: TRIAL_READ_WAIT_MS });
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
        // Measured per call, never cached: a rebuild that grants the GPU, a reshape that changes the memory cap and a
        // download that lands all change the answer without anything here being told.
        localModelFit: i.localModelFit.handler(async () =>
            localModelFit(services.workspace.root, await localModelPrefetchStatus(services.workspace.root)),
        ),
        // The capability list rides along so a stop cannot cancel a transfer an added card is waiting on.
        localModelPrefetch: i.localModelPrefetch.handler(async ({ input }) =>
            localModelPrefetch(services.workspace.root, input.action, await services.capabilities.list()),
        ),
    };
};
