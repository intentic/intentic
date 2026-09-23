import { procedure } from "../protocol/route-meta.js";
import { z } from "zod";
import { NativeProviderParamSchema } from "../schemas/agent.js";
import { ModelsSchema } from "../schemas/providers/provider-oauth.js";

// Providers a turn can be sent to beyond the fixed native list: the ACP agents installed here and the model endpoints
// this sandbox serves. Deliberately not the capability list (/capabilities, maintainer): a name and a label say what a
// chat may run on, and say nothing about what holds a credential or what this box can reach.
export const RunnableProvidersSchema = z.object({
    // The one thing about the fixed native list this route says, and it says no more than the ACP and endpoint lists
    // do: a name a message can be addressed to. Which account answers for it, and whose it is, stays behind
    // /accounts, whose tier is a different question. Without this a reader who may drive a turn but not read that
    // route sees no native provider as runnable and is told to connect one the box already has.
    native: z.array(NativeProviderParamSchema.shape.provider).describe("Native providers with a working credential here, by id; never what holds it."),
    agents: z
        .array(z.object({ id: z.string(), label: z.string() }))
        .describe("ACP agents installed here. The id is the provider id itself, the label its display name."),
    endpoints: z
        .array(
            z.object({
                id: z.string(),
                label: z.string(),
                // Kept apart because only this tells weights the sandbox runs itself from a server it was pointed at;
                // both mint an `endpoint/<id>` provider.
                kind: z.enum(["endpoint", "localmodel"]),
            }),
        )
        .describe("Model endpoints, already prefixed `endpoint/`, including the daemon-provisioned free trial."),
});
export type RunnableProviders = z.infer<typeof RunnableProvidersSchema>;

// The provider is a parameter, not a route per provider; adding one is a row in the catalog registry. Endpoints keep
// their own route (endpoints.contract.ts): they are user-created and unbounded, and a missing one is NOT_FOUND, not an
// empty catalog.
export const providersContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/providers",
            summary: "Providers a chat can run on here",
            description:
                "The installed ACP agents and model endpoints, which are the providers this sandbox adds to the fixed native list. A read for anyone who may watch or drive a turn: it names what a message can be addressed to, not what credential stands behind it.",
        })
        .meta({ guest: true })
        .output(RunnableProvidersSchema),
    // Never empty: live discovery with a persisted/seed floor; order is the provider's own, not re-ranked.
    models: procedure
        .route({
            method: "GET",
            path: "/providers/{provider}/models",
            summary: "Models one provider offers",
            description:
                "Every model this provider serves and which one it defaults to. Never empty: it is discovered live with a stored list behind it. The order is the provider's own preference and is not rearranged here.",
        })
        .meta({ guest: true })
        .input(NativeProviderParamSchema)
        .output(ModelsSchema),
};
