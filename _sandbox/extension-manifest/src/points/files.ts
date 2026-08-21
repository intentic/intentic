import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

/* WHICH WORKSPACE FILE MAKES THIS EXTENSION'S VIEW STALE, the extension's half of the core's
 * WORKSPACE_STATE_FILES table (@intentic/sandbox-contract), in the same two fields so the browser can union them
 * without translating.
 *
 * An intentic workspace is file-first: the agent edits /work with its own file tools, out of band from every
 * HTTP route, and the daemon's filesystem watcher is the ONLY thing that can tell a browser its view went stale.
 * Before this contribution point existed an extension had no way into that push, so every one of them polled,
 * and the core's table had to hardcode `automations`/`automation-approvals`, query keys owned by an extension,
 * because the extension itself couldn't declare them. Declaring is now the extension's job and unioning is the
 * host's.
 *
 * It rides the manifest rather than a runtime api.workspace.onDidChangeFiles for two reasons: the owner sees at
 * install which of their files an extension reads, and there is nothing imperative left to get wrong, no
 * subscribe, no unsubscribe, no listener that quietly stops firing. */
export const FileContributionSchema = z.object({
    /* Workspace-root-relative, forward-slash, the space the watcher's changed paths arrive in. Matched by
     * PREFIX, so one entry covers an exact file (`.intentic/config/automations.json`), a directory (`.intentic/config/drafts/`
     *, keep the trailing slash so it cannot match a sibling file) or a name family (`.intentic/environment.`).
     * Deliberately not a glob: prefix is the whole matching rule on both sides of this union. */
    path: z
        .string()
        .min(1)
        .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
            message: "path must be workspace-root-relative and stay inside the workspace",
        })
        .describe(
            "Workspace-root-relative, forward-slash, matched by prefix, so one entry covers an exact file (`.intentic/config/automations.json`), a directory (`.intentic/config/drafts/`, with the trailing slash so it cannot match a sibling file) or a name family (`.intentic/environment.`). Not a glob.",
        ),
    /* The browser query keys those contents feed, the first element of the extension's own
     * `api.sandbox.key(...)` keys, which is what makes them match (the sandbox id is a SUFFIX). Empty is not
     * allowed: a path that makes nothing stale is a declaration with no effect, and saying so at install beats
     * discovering it as a view that never refreshes.
     *
     * Keep the paths as narrow as the view actually needs. A broad prefix costs every connected browser a
     * refetch per matching write, and a write-heavy path (an index, a transcript, a log) turns that into a
     * request storm, the reason the core table leaves the daemon's own machine state off the push entirely. */
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
