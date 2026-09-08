import { z } from "zod";
import { PanelLaunchSchema } from "./panels.js";
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
// status mirrors GitSyncResult plus turn outcomes skipped/error; behind/ahead/head/message are present per status.
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
// Adds named app instances to an existing monorepo: template is a key from the source repo's templates.json, name is
// the user's chosen instance name.
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
// Runs vitest in a one-shot tmux panel session (panel-<repo>--<session>). dirs are repo-relative package dirs; ""
// targets the repo root.
export const RunTestsSchema = z.object({
    repo: z.string().describe("Which repository."),
    session: z.string().describe("What to call the terminal this runs in, so you can find it again."),
    dirs: z.array(z.string()).min(1).describe("Which projects to test, as folders relative to the repository. Empty targets the repository root."),
});
// One addable app type from the source repo's templates.json, for the Add-app picker.
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
// One app instance in a monorepo, with its own dev server and status. previewUrl is
// https://preview-<repo>--<app>-<sandboxId>.<zone>, absent without a zone or connect token.
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
    // Same as a repo's panel row: an app installs at its monorepo's root, so this is the root's node_modules.
    installed: z
        .boolean()
        .describe("Whether its dependencies are installed, which is what decides whether a start takes seconds or an install first."),
    launch: PanelLaunchSchema.optional().describe(
        "Where a start the sandbox is running has got to: its shell coming up, installing, its dev command running with nothing listening yet, or exited back to a prompt. Absent when nothing is starting and once it serves.",
    ),
});
export type RepoApp = z.infer<typeof RepoAppSchema>;
export const AppsListSchema = z.object({ apps: z.array(RepoAppSchema).describe("The apps in this repository.") });
export type AppsList = z.infer<typeof AppsListSchema>;
// A pnpm-workspace package, discovered from pnpm-workspace.yaml's globs. group is the top-level dir segment, the
// dependencies view's coloring axis.
export const WorkspacePackageSchema = z.object({
    name: z.string().describe("The name the package declares."),
    dir: z.string().describe("Where it lives, relative to the repository."),
    group: z.string().describe("The top-level folder it sits under, which is what a diagram colours by."),
});
export type WorkspacePackage = z.infer<typeof WorkspacePackageSchema>;
export const WorkspaceDepTypeSchema = z.enum(["prod", "dev", "peer"]);
export type WorkspaceDepType = z.infer<typeof WorkspaceDepTypeSchema>;
// A workspace-internal dependency edge: from depends on to, typed by which dependency block declared it.
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
// Path params for the per-repo apps routes: repo names the monorepo, validated like PanelRepoParam.
export const RepoAppsParamSchema = z.object({ repo: z.string().describe("Which repository.") });
export const AppParamSchema = z.object({
    repo: z.string().describe("Which repository."),
    app: z
        .string()
        .min(1)
        .regex(/^[a-z][a-z0-9-]*$/)
        .describe("Which app inside it."),
});
