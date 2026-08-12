import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// A sidebar element family the extension may register at runtime (api.views.register): `rail` = a global
// left-rail tile routed at /ext/:ext/:key?; `directory` = a per-repo panel opened from the Workspace tree;
// `sandbox` = a tab on the Sandbox hub, for a view whose subject is the BOX rather than the work (see
// ViewRegistration.surface).
export const ViewContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    label: z.string().min(1).describe("The name shown on the tile or tab. The manifest's value wins over the one passed at registration."),
    surface: z
        .enum(["rail", "directory", "sandbox"])
        .describe(
            "Where it appears. `rail` is a tile in the global left rail; `directory` is a panel opened from a repo in the Workspace tree; `sandbox` is a tab on the Sandbox hub, for a view whose subject is the box rather than the work.",
        ),
    // Whether this view may badge its tile (ViewRegistration.badge). Declared here, like a command's
    // keybinding, because it is consequential: a badge interrupts the user from every other screen in the app.
    // Absent ⇒ the host drops any badge the extension registers.
    badge: z
        .boolean()
        .optional()
        .describe(
            "Allow this view to put a count on its tile. Declared because a badge interrupts from every other screen in the app; leave it out and any badge the extension registers is dropped.",
        ),
});
export type ViewContribution = z.infer<typeof ViewContributionSchema>;

export const viewsPoint = {
    name: "views",
    description:
        "Sidebar elements this extension may register at runtime. Each entry reserves an id and a surface; the extension supplies the component with api.views.register, and the host refuses any registration this list does not cover.",
    schema: z.array(ViewContributionSchema),
} as const satisfies ContributionPoint;
