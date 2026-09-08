import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// Which workspace file makes this extension's view stale; the extension's half of the core's WORKSPACE_STATE_FILES
// table (@intentic/sandbox-contract), same two fields so the browser can union them without translating. Rides the
// manifest rather than a runtime subscription, so the owner sees at install which files an extension reads.
export const FileContributionSchema = z.object({
    // Workspace-root-relative, forward-slash, matched by prefix: covers an exact file, a directory (keep the trailing
    // slash), or a name family. Not a glob.
    path: z
        .string()
        .min(1)
        .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
            message: "path must be workspace-root-relative and stay inside the workspace",
        })
        .describe(
            "Workspace-root-relative, forward-slash, matched by prefix, so one entry covers an exact file (`.intentic/config/automations.json`), a directory (`.intentic/config/approvals/`, with the trailing slash so it cannot match a sibling file) or a name family (`.intentic/environment.`). Not a glob.",
        ),
    // The browser query keys this path's contents feed. Keep both this and the path as narrow as the view actually
    // needs; a broad prefix costs every connected browser a refetch per matching write.
    invalidates: z
        .array(z.string().min(1))
        .min(1)
        .describe(
            "The query keys this path makes stale, the first element of your own api.sandbox.key(...) keys. Keep both this and the path as narrow as the view actually needs: a broad prefix costs every connected browser a refetch on every matching write.",
        ),
});
export type FileContribution = z.infer<typeof FileContributionSchema>;

export const filesPoint = {
    name: "files",
    description:
        "Which workspace files back your views, so the daemon's file watcher can tell the browser they went stale instead of you polling for it. The agent edits the workspace out of band from every HTTP route, and this push is the only thing that can notice.",
    schema: z.array(FileContributionSchema),
} as const satisfies ContributionPoint;
