import { z } from "zod";

// ---- (2026-11-25) a deployment told to the forge: POST /ci/deployments ------------------------------------------------
// The repository's forge shows that a commit went to an environment, through the token of the github/gitlab
// connection the CI board already uses: on GitHub a Deployment (`environment`) and its statuses, on GitLab a commit
// status named `deploy/<environment>`. The first report for a deployment answers its `deploymentId`; the later states
// pass it back. A token without the scope is refused in the forge's words, never retried.
export const CiDeploymentStateSchema = z.enum(["in_progress", "success", "failure", "inactive"]);
export const CiDeploymentReportSchema = z.object({
    repo: z.string().min(1).max(500),
    sha: z.string().regex(/^[0-9a-f]{40,64}$/),
    environment: z.string().min(1).max(100),
    state: CiDeploymentStateSchema,
    production: z.boolean().optional(),
    description: z.string().max(140).optional(),
    environmentUrl: z.string().url().max(2000).optional(),
    logUrl: z.string().url().max(2000).optional(),
    deploymentId: z.number().optional(),
});
export type CiDeploymentReport = z.infer<typeof CiDeploymentReportSchema>;
export const CiDeploymentAnswerSchema = z.object({
    deploymentId: z.number().optional(),
    // The forge's page for it, when it has one.
    url: z.string().optional(),
});
export type CiDeploymentAnswer = z.infer<typeof CiDeploymentAnswerSchema>;
