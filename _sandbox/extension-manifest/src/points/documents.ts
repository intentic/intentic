import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

/* A per-directory document family the extension may register at runtime (api.documents.register): the provider
 * marks the directory rows it can explain in the Workspace tree, and the host opens its component as a tab —
 * see DocumentProviderRegistration.
 *
 * Only the id and the label are declared, deliberately. The consequential part of a viewer is which FILES it
 * takes over, and of a command its global shortcut — both are decided in the manifest because the owner must see
 * them. A document provider takes nothing over: it adds an icon to rows it has something for, and every one of
 * those rows is evidence the owner can see for themselves. So the manifest gates WHETHER the extension may mark
 * up the tree at all, and the per-row wording stays with the provider, which is the only thing that knows what
 * it found. */
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
