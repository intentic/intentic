import { oc } from "@orpc/contract";
import { NativeProviderParamSchema } from "../schemas/agent.js";
import { ModelsSchema } from "../schemas/provider-oauth.js";

// EVERY NATIVE PROVIDER'S PICKER CATALOG, ON ONE ROUTE.
//
// There were five of these: /claude/models, /codex/models, /grok/models, /kimi/models, /gemini/models, one per
// provider, each a contract entry, a route factory and a service field wired separately. They differed in
// nothing: same method, same output schema, same "the daemon's catalog for this provider, never empty". Three of
// the five route files were the same fifteen lines with a name swapped, and the daemon paid for that shape twice
// more in the branch chains that had to fan back out over the providers to ask them all the same question.
//
// So the provider is a PARAMETER, not five routes. Adding one is a row in the daemon's catalog registry, the
// same discipline the adapter registry already applies to serving a turn, rather than a vertical slice through
// the contract, the router, the service container and every test double.
//
// Endpoints keep their own route (endpoints.contract.ts) and should: they are user-created and unbounded, their
// id names a capability that may not exist, and a missing one is a NOT_FOUND rather than an empty catalog. That
// is a different question with a different failure, not a sixth provider.
export const providersContract = {
    // One provider's models (+ its default id), never empty, live discovery with a persisted/seed floor behind
    // it. Order is the provider's own preference order and is not re-ranked here; see ModelsSchema.
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
