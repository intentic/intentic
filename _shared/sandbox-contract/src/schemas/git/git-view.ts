import { z } from "zod";
import { RepoParamSchema } from "../shared.js";
import { WorkspaceScopeSchema } from "../workspace/workspace-tree.js";

export const GitViewSchema = WorkspaceScopeSchema.refine(
    (view) => !(view.agent !== undefined && (view.branch !== undefined || view.repo !== undefined)) && (view.repo === undefined || view.branch !== undefined),
    { message: "Choose one checkout: a conversation, a branch, or the shared workspace." },
);
export type GitView = z.infer<typeof GitViewSchema>;

export const GitViewQuerySchema = z.object({ view: GitViewSchema.optional() });
export const GitRepoParamSchema = RepoParamSchema.extend({ view: GitViewSchema.optional() });

export const EncodedGitViewSchema = z.union([
    GitViewSchema,
    z.string().transform((value, ctx) => {
        try { return JSON.parse(value); } catch {
            ctx.addIssue({ code: "custom", message: "Invalid checkout selection." });
            return z.NEVER;
        }
    }).pipe(GitViewSchema),
]);
