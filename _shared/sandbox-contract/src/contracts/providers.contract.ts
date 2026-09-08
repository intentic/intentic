import { oc } from "@orpc/contract";
import { NativeProviderParamSchema } from "../schemas/agent.js";
import { ModelsSchema } from "../schemas/provider-oauth.js";

// The provider is a parameter, not a route per provider; adding one is a row in the catalog registry. Endpoints keep
// their own route (endpoints.contract.ts): they are user-created and unbounded, and a missing one is NOT_FOUND, not an
// empty catalog.
export const providersContract = {
    // Never empty: live discovery with a persisted/seed floor; order is the provider's own, not re-ranked.
    models: oc
        .route({
            method: "GET",
            path: "/providers/{provider}/models",
            summary: "Models one provider offers",
            description:
                "Every model this provider serves and which one it defaults to. Never empty: it is discovered live with a stored list behind it. The order is the provider's own preference and is not rearranged here.",
        })
        .input(NativeProviderParamSchema)
        .output(ModelsSchema),
};
