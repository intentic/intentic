import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A per-directory document family the extension may register at runtime; the provider marks rows in the Workspace tree
// it can explain, and the host opens its component as a tab. Only id and label are declared: which rows to mark is the
// provider's own call, made visibly, so nothing else needs owner approval.
export const DocumentContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    // The family's human name, shown in the install dialog beside the extension's other contributions.
    label: z
        .string()
        .min(1)
        .describe(
            "The family's name, shown in the install dialog beside your other contributions. Per-row wording stays with the provider, which is the only thing that knows what it found.",
        ),
});
export type DocumentContribution = z.infer<typeof DocumentContributionSchema>;

export const documentsPoint = {
    name: "documents",
    description:
        "Per-directory documents this extension can offer. Your provider marks the rows in the Workspace tree it has something to say about, and the host opens your component as a tab.",
    schema: z.array(DocumentContributionSchema),
} as const satisfies ContributionPoint;
