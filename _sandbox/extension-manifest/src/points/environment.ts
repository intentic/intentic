import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A Dockerfile fragment baked into the sandbox image overlay so the extension's tools are present at runtime
// (a whisper binary, a psql client, …). The daemon rejects FROM and privileged `# intentic:runtime` directives
// from extension fragments (those stay daemon-owned), and the owner approves the composed overlay + rebuilds
// out-of-band.
export const EnvironmentContributionSchema = z.object({
    fragment: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "fragment must stay inside the checkout" })
        .describe(
            "Checkout-relative path to a file holding ONLY RUN and ENV instructions. FROM and privileged directives are rejected — those stay daemon-owned.",
        ),
});
export type EnvironmentContribution = z.infer<typeof EnvironmentContributionSchema>;

export const environmentPoint = {
    name: "environment",
    description:
        "A Dockerfile fragment baked into the sandbox image so your tools are actually installed at runtime — a whisper binary, a psql client. The owner approves the composed overlay and rebuilds out of band, so this does not take effect immediately.",
    schema: EnvironmentContributionSchema,
} as const satisfies ContributionPoint;
