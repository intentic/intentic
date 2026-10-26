import { procedure } from "../protocol/route-meta.js";
import { OkSchema } from "../schemas/shared.js";
import { ServiceIdParamSchema, ServiceSchema, ServicesListSchema } from "../schemas/services.js";

// Services (ServiceSchema): who unattended work acts as. A maintainer writes automations, so a maintainer may name who
// they run as; what a service reaches is still never more than its steward may, whoever wrote it.
export const servicesContract = {
    list: procedure
        .route({
            method: "GET",
            path: "/access/services",
            summary: "The services unattended work runs as",
            description: "Every service: who it acts for, and the access profile its runs are held to.",
        })
        .meta({ floor: "maintainer" })
        .output(ServicesListSchema),
    // Upsert by id, re-saving the same id edits that service.
    save: procedure
        .route({
            method: "POST",
            path: "/access/services",
            summary: "Create or edit a service",
            description:
                "Writes the whole service; sending an id that exists edits it. Its steward must be the owner or someone on the roster, and its profile one this sandbox has. Every automation, link and token running as it changes with it from their next turn.",
        })
        .input(ServiceSchema)
        .output(OkSchema),
    // Refused while anything still runs as it: an automation naming a service that is gone is skipped with that reason,
    // which is a quiet failure nobody chose.
    remove: procedure
        .route({
            method: "DELETE",
            path: "/access/services/{id}",
            summary: "Delete a service",
            description:
                "Removes the service. Refused while an automation, a sender rule, an inbound link or a control token still runs as it; point them elsewhere first.",
        })
        .input(ServiceIdParamSchema)
        .output(OkSchema),
};
