import { oc } from "@orpc/contract";
import { ModelsSchema } from "../schemas.js";

// Kimi Code's picker catalog. Authentication and accounts belong to the bundled translator just like the other
// routed subscriptions (translator.contract.ts); this provider-specific route only projects CLIProxyAPI's Kimi
// model definitions into the shared picker shape.
export const kimiContract = {
    models: oc.route({ method: "GET", path: "/kimi/models" }).output(ModelsSchema),
};
