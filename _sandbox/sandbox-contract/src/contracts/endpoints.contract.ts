import { oc } from "@orpc/contract";
import { CapabilityIdParamSchema, ModelsSchema } from "../schemas.js";

// An `endpoint` capability's picker catalog — the models the configured server itself publishes, read from its
// own /v1/models. Every other provider's catalog is one fixed route because there is one of each; endpoints are
// user-created and unbounded, so the id rides in the path. There is no seed floor and no static list: what a
// model API serves is knowable only by asking it, and an empty answer is the honest report that we could not.
export const endpointsContract = {
    models: oc.route({ method: "GET", path: "/endpoints/{id}/models" }).input(CapabilityIdParamSchema).output(ModelsSchema),
};
