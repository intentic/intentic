import { oc } from "@orpc/contract";
import { z } from "zod";
import { CapabilityIdParamSchema, ModelsSchema } from "../schemas.js";

// An `endpoint` capability's picker catalog — the models the configured server itself publishes, read from its
// own /v1/models. Every other provider's catalog is one fixed route because there is one of each; endpoints are
// user-created and unbounded, so the id rides in the path. There is no seed floor and no static list: what a
// model API serves is knowable only by asking it, and an empty answer is the honest report that we could not.

/* The free trial's remaining allowance, on the endpoints contract because the trial IS an endpoint — the one
 * the daemon provisions rather than the user (agent-catalog.ts TRIAL_ENDPOINT_ID). It is a separate read from
 * the catalog above because it answers a different question and changes on a different clock: the model list is
 * a property of the upstream, while this is a property of the ACCOUNT and moves with every message sent.
 *
 * `available` false is the ordinary answer, not an error: most sandboxes run against a platform that serves no
 * trial, and the picker simply has no trial row to badge.
 */
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
});
export type TrialStatusResponse = z.infer<typeof TrialStatusSchema>;

export const endpointsContract = {
    models: oc.route({ method: "GET", path: "/endpoints/{id}/models" }).input(CapabilityIdParamSchema).output(ModelsSchema),
    trial: oc.route({ method: "GET", path: "/endpoints/trial/status" }).output(TrialStatusSchema),
};
