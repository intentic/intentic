import { oc } from "@orpc/contract";
import { AddInventoryInputSchema, InventoryListSchema, InventoryNameParamSchema } from "../schemas/inventory.js";

// The i.have.* / i.want.service entries in deploy.config.ts's managed region. add/remove rewrite the region and
// commit it (mirroring an agent edit) and return the full updated list so the UI re-renders from one response.
// Deploy-target hosts self-register out-of-band via the daemon's plain /enroll route (connect-host script).
export const inventoryContract = {
    list: oc
        .route({
            method: "GET",
            path: "/inventory",
            summary: "Machines and services you have declared",
            description: "What the deployment configuration says this setup owns and what it wants provisioned.",
        })
        .output(InventoryListSchema),
    add: oc
        .route({
            method: "POST",
            path: "/inventory",
            summary: "Declare a machine or service",
            description:
                "Writes the entry into the configuration file and commits it, exactly as an agent editing that file by hand would. Answers with the whole updated list, so a screen redraws from one response.",
        })
        .input(AddInventoryInputSchema)
        .output(InventoryListSchema),
    remove: oc
        .route({
            method: "DELETE",
            path: "/inventory/{name}",
            summary: "Undeclare a machine or service",
            description: "Takes the entry back out of the configuration and commits that too. Answers with the whole updated list.",
        })
        .input(InventoryNameParamSchema)
        .output(InventoryListSchema),
};
