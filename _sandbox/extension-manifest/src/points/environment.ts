import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A Dockerfile fragment baked into the sandbox image overlay so the extension's tools are present at runtime
// (a whisper binary, a psql client, …). The daemon rejects FROM and privileged `# intentic:runtime` directives
// from extension fragments (those stay daemon-owned), and the owner approves the composed overlay + rebuilds
// out-of-band.
/* NO `pack` FIELD HERE, deliberately, though its sibling the `cli` contribution has one. A pack reference is
 * the better way to ask for a tool the sandbox already ships (see that field), but expressing "either a
 * fragment or a pack" here means `fragment` stops being required — and that drops `required: ["fragment"]`
 * from the wire contract, which the lock gate correctly reads as something a client could have relied on. No
 * extension needs it yet: the one manifest using this point asks for an npm package, and a connector wanting
 * a packed tool declares it on its `cli` contribution, which is where the duplication this solves came from.
 * Worth adding the day something needs it, as a declared contract change with a Breaking-Note, rather than
 * spending one now on symmetry. */
export const EnvironmentContributionSchema = z.object({
    fragment: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "fragment must stay inside the checkout" })
        .describe(
            "Checkout-relative path to a file holding ONLY RUN and ENV instructions. FROM and privileged directives are rejected: those stay daemon-owned.",
        ),
});
export type EnvironmentContribution = z.infer<typeof EnvironmentContributionSchema>;

export const environmentPoint = {
    name: "environment",
    description:
        "A Dockerfile fragment baked into the sandbox image so your tools are actually installed at runtime: a whisper binary, a psql client. The owner approves the composed overlay and rebuilds out of band, so this does not take effect immediately.",
    schema: EnvironmentContributionSchema,
} as const satisfies ContributionPoint;
