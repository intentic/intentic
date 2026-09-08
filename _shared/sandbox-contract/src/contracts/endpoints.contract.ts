import { oc } from "@orpc/contract";
import { z } from "zod";
import { CapabilityIdParamSchema } from "../schemas/capabilities.js";
import { ModelsSchema } from "../schemas/provider-oauth.js";

// Endpoints are user-created and unbounded (unlike every other provider, which has one fixed catalog route), so the id
// rides in the path.

// The trial is an endpoint the daemon provisions rather than the user (TRIAL_ENDPOINT_ID); a separate read since
// this is a property of the account, moving with every message, not of the upstream model list.
const TrialHealthSchema = z.enum(["unknown", "healthy", "degraded", "unavailable"]);
export type TrialHealth = z.infer<typeof TrialHealthSchema>;

export const TrialStatusSchema = z.object({
    available: z.boolean(),
    allowance: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    // The shared trial pool's last real chat outcome. `unknown` means no recent turn has measured it.
    health: TrialHealthSchema,
    // ISO stamp of the next reset, absent until the platform has answered once.
    resetsAt: z.string().optional(),
    // Earliest known time a quarantined upstream key can be tried again.
    retryAt: z.string().optional(),
    // The real model that served the last trial message; the published id only names the trial ladder.
    servedModel: z.string().optional(),
});
export type TrialStatusResponse = z.infer<typeof TrialStatusSchema>;

export const endpointsContract = {
    models: oc
        .route({
            method: "GET",
            path: "/endpoints/{id}/models",
            summary: "Models a connected server offers",
            description:
                "Asks one configured model server what it serves. There is no built-in list and no fallback: what a server offers is knowable only by asking it, so an empty answer is the honest report that we could not.",
        })
        .input(CapabilityIdParamSchema)
        .output(ModelsSchema),
    trial: oc
        .route({
            method: "GET",
            path: "/endpoints/trial/status",
            summary: "What is left of the free trial",
            description:
                "The allowance, what has been used, when it resets, and which model actually answered the last message. Not being available is the ordinary answer rather than a failure: most sandboxes run against a platform that offers no trial at all.",
        })
        .output(TrialStatusSchema),
};
