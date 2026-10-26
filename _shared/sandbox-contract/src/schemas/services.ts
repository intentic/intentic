import { z } from "zod";
import { entryId } from "./internal.js";

// A SERVICE: a named non-human principal unattended work acts as (docs/architecture/access.md). An automation, one of its
// sender rules, an inbound link or a control token names one in `runAs`, and every turn it starts acts for the service's
// steward, a person, narrowed by the service's access profile. An agent so never holds more than the person it acts for,
// and a steward who leaves the roster takes the reach of every service they steward with them.
// Holds no credential: a steward is an address on the roster, a profile an id.
export const ServiceSchema = z.object({
    id: entryId.describe("The service's id, what `runAs` names."),
    label: z.string().max(60).optional().describe("What to call it on screen, like 'Marketing bot'. Absent falls back to the id."),
    brief: z.string().max(200).optional().describe("What it does, in one line."),
    steward: z
        .string()
        .min(3)
        .max(320)
        .describe(
            "Who it acts for, by email: the sandbox's owner or someone on its roster. Its runs reach at most what this person may, and nothing once they leave.",
        ),
    profile: entryId
        .optional()
        .describe("The access profile its runs are held to, inside what its steward may. Absent means everything its steward may."),
});
export type Service = z.infer<typeof ServiceSchema>;

export const ServicesListSchema = z.object({ services: z.array(ServiceSchema).describe("Every service unattended work here may run as.") });
export type ServicesList = z.infer<typeof ServicesListSchema>;

export const ServiceIdParamSchema = z.object({ id: entryId.describe("Which service.") });

// What a `runAs` holds: one service's id.
export const ServiceRefSchema = entryId.describe("Which service it acts as.");
