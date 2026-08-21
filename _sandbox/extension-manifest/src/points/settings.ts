import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A typed setting descriptor the host renders schema-driven into the Settings page and persists daemon-side.
export const SettingContributionSchema = z.object({
    key: z.string().regex(/^[a-z0-9][a-zA-Z0-9-]*$/),
    type: z.enum(["boolean", "string", "number", "enum"]).describe("Which control the Settings page draws. `enum` reads its choices from `enum`."),
    title: z.string().min(1),
    description: z.string().optional().describe("The line under the control."),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    enum: z.array(z.string()).optional().describe('The choices, for type "enum". Meaningless otherwise.'),
    secret: z
        .boolean()
        .optional()
        .describe("Mask the value in the UI and strip it from reads: a set secret round-trips as 'still set', never as its value."),
    env: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .optional()
        .describe(
            "Inject the stored value into the agent's shell environment under this name, every turn. How a credential you hold reaches the agent's command-line tools.",
        ),
});
export type SettingContribution = z.infer<typeof SettingContributionSchema>;

export const settingsPoint = {
    name: "settings",
    description:
        "Typed settings the host renders into the Settings page for you and persists daemon-side. You never draw the form or store the value; you read it back with api.settings.get.",
    schema: z.array(SettingContributionSchema),
} as const satisfies ContributionPoint;
