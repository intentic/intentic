import { z } from "zod";
// Every discovered repo's id (root-relative dir under /work), sorted, roles included.
export const ReposListSchema = z.object({
    repos: z
        .array(z.string())
        .describe('Every repository\'s id, sorted. An id is its folder relative to the workspace root, and "root" is the workspace itself.'),
});
export const CloneRepoSchema = z.object({
    name: z.string().min(1).describe("What to call it in the workspace."),
    cloneUrl: z.string().min(1).describe("Where to clone it from."),
    branch: z.string().optional().describe("Which branch to check out. Leave it out for the repository's default."),
});
export const CloneResultSchema = z.object({
    name: z.string().describe("What it ended up called."),
    path: z.string().describe("Where it landed."),
});
// Per-repo result of a workspace sync (fetch + guarded fast-forward). `status` mirrors GitSyncResult plus the
// turn-orchestration outcomes skipped/error; behind/ahead/head/message are present per status (see RepoSyncOutcome).
export const RepoSyncSchema = z.object({
    repo: z.string().describe("Which repository."),
    status: z
        .enum(["updated", "current", "dirty", "diverged", "no-remote", "skipped", "error"])
        .describe(
            "What happened to it. Dirty and diverged are why a repository was left alone: it had uncommitted work, or it had moved in a way that cannot be fast-forwarded.",
        ),
    behind: z.number().optional().describe("How many commits it was behind."),
    ahead: z.number().optional().describe("How many commits it was ahead."),
    head: z.string().optional().describe("The commit it ended up on."),
    message: z.string().optional().describe("What went wrong, when something did."),
});
export const WorkspaceSyncSchema = z.object({ repos: z.array(RepoSyncSchema).describe("One entry per repository, saying what happened to it.") });
// Add one or more named app instances into an EXISTING monorepo. Each entry pairs a template key from the
// source repo's templates.json manifest (e.g. "api", "web", "landing") with a user-chosen instance name
// (e.g. "shop-api"); {repo} names the target monorepo.
export const AppInstanceInputSchema = z.object({
    template: z.string().min(1).describe("Which kind of app to scaffold, by its key in the template list."),
    name: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/)
        .describe("What to call this one."),
});
export type AppInstanceInput = z.infer<typeof AppInstanceInputSchema>;
export const AddAppsSchema = z.object({
    repo: z.string().describe("Which repository to scaffold into."),
    apps: z.array(AppInstanceInputSchema).min(1).describe("The apps to add."),
});
// Run vitest for one or more repo-relative project dirs in a named one-shot tmux panel session
// (panel-<repo>--<session>), driven by the apps extension's Run-tests actions. `session` is a slug suffix
// (an app/package name as `<name>__test`, or `tests` for the library section); `dirs` are repo-relative
// package dirs, where "" targets the repo root.
export const RunTestsSchema = z.object({
    repo: z.string().describe("Which repository."),
    session: z.string().describe("What to call the terminal this runs in, so you can find it again."),
    dirs: z.array(z.string()).min(1).describe("Which projects to test, as folders relative to the repository. Empty targets the repository root."),
});
// One addable app type the configured source repo offers (from its templates.json), listed for the operator
// panel's Add-app picker: the manifest key + its label/description.
export const TemplateSummarySchema = z.object({
    key: z.string().describe("The id to name when scaffolding one."),
    label: z.string().describe("What to call it on screen."),
    description: z.string().describe("What you get."),
});
export type TemplateSummary = z.infer<typeof TemplateSummarySchema>;
export const TemplatesListSchema = z.object({
    templates: z.array(TemplateSummarySchema).describe("The kinds of app the configured source repository knows how to scaffold."),
});
export type TemplatesList = z.infer<typeof TemplatesListSchema>;
// One app instance currently in a monorepo, with its own preview dev server + live status (started/stopped
// from the apps extension). `app` is the user-chosen instance name (the _apps/ dir); `kind` is what sort of
// app it is, the manifest key it was scaffolded from (api/web/landing), else the framework detected from its
// dependencies (astro/next/…), and absent when it was discovered purely by its `dev` script. previewUrl is
// https://preview-<repo>--<app>-<sandboxId>.<zone> (absent on loopback, no zone or no connect token).
export const RepoAppSchema = z.object({
    app: z.string().describe("The app's name, which is also its folder."),
    kind: z
        .string()
        .optional()
        .describe(
            "What sort of app it is: the template it came from, or the framework worked out from its dependencies. Absent when it was found purely by having a dev script.",
        ),
    previewUrl: z.string().optional().describe("Where to open it. Absent when this sandbox has no outside address."),
    running: z.boolean().describe("Whether its dev server is up."),
    healthy: z.boolean().describe("Whether it is actually answering."),
});
export type RepoApp = z.infer<typeof RepoAppSchema>;
export const AppsListSchema = z.object({ apps: z.array(RepoAppSchema).describe("The apps in this repository.") });
export type AppsList = z.infer<typeof AppsListSchema>;
// One workspace package in a pnpm monorepo, discovered from pnpm-workspace.yaml's packages globs. `dir` is the
// repo-relative package dir (e.g. "_editor/web"); `group` is its top-level dir segment (e.g. "_editor"), the
// dependencies view's coloring axis.
export const WorkspacePackageSchema = z.object({
    name: z.string().describe("The name the package declares."),
    dir: z.string().describe("Where it lives, relative to the repository."),
    group: z.string().describe("The top-level folder it sits under, which is what a diagram colours by."),
});
export type WorkspacePackage = z.infer<typeof WorkspacePackageSchema>;
export const WorkspaceDepTypeSchema = z.enum(["prod", "dev", "peer"]);
export type WorkspaceDepType = z.infer<typeof WorkspaceDepTypeSchema>;
// A workspace-internal dependency edge: `from` DEPENDS ON `to` (from's package.json lists to), typed by which
// dependency block declared it. Pure data, layout/direction is the client's concern.
export const WorkspaceDepEdgeSchema = z.object({
    from: z.string().describe("The package that depends."),
    to: z.string().describe("The package it depends on."),
    type: WorkspaceDepTypeSchema.describe("Which kind of dependency declared it."),
});
export type WorkspaceDepEdge = z.infer<typeof WorkspaceDepEdgeSchema>;
export const WorkspaceGraphSchema = z.object({
    packages: z.array(WorkspacePackageSchema).describe("Every package in the repository."),
    edges: z.array(WorkspaceDepEdgeSchema).describe("Which of them use which. Pure data: how to lay it out is yours to decide."),
});
export type WorkspaceGraph = z.infer<typeof WorkspaceGraphSchema>;
// Path params for the per-repo apps routes: the monorepo name (validated in the handler like PanelRepoParam)
// and, for per-app preview control (start/stop), the app key (api/web/landing).
export const RepoAppsParamSchema = z.object({ repo: z.string().describe("Which repository.") });
export const AppParamSchema = z.object({
    repo: z.string().describe("Which repository."),
    app: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/)
        .describe("Which app inside it."),
});
