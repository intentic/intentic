import { z } from "zod";
import type { ContributionPoint } from "../contribution-point.js";

// (2026-11-26) A MODEL ROLE: one job an extension starts agent runs for (Pipelines' Fix, a documentation pass), which the
// owner puts on a model setup in Sandbox ▸ Agent ▸ Models like the sandbox's own jobs. The daemon merges the enabled
// extensions' roles with its own table (@intentic/sandbox-contract/models/model-roles) and serves them to that page, and a
// run the extension starts names its role as `job`, which picks the setup's model when the run names none. Before
// this the core's table listed every extension's jobs, so a job could not come and go with its extension.

// A role's id, as the owner's choice is stored under it (`roleSetups`) and a run names it (`job`): lowercase words
// joined by dashes.
export const MODEL_ROLE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
export const MODEL_ROLE_ID_MAX = 40;

export const ModelRoleContributionSchema = z.object({
    id: z
        .string()
        .max(MODEL_ROLE_ID_MAX)
        .regex(MODEL_ROLE_ID, "a model role's id is lowercase words joined by dashes")
        .describe(
            "The job's id: what the owner's choice of setup is stored under, and what a run this extension starts names as `job` on POST /agent. Keep it once shipped: a stored choice names it. An id the sandbox's own jobs or an earlier extension already use is not taken.",
        ),
    label: z.string().min(1).max(40).describe("What the settings page calls the job, in the owner's words: `Pipeline fixes`."),
    explanation: z
        .string()
        .min(1)
        .max(300)
        .describe("One sentence under the label on what starts the job, saying more than the label does: `The agent started by Fix on a failed pipeline.`"),
    icon: z.string().min(1).optional().describe("A name from the host's icon set for the job's chip. Absent draws a wrench."),
    setup: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe(
            "The setup the job is suggested: where a sandbox that never placed its jobs runs it, and where the settings page puts it when the owner places it again. What the work needs, not what it costs today. Absent is `medium`.",
        ),
});
export type ModelRoleContribution = z.infer<typeof ModelRoleContributionSchema>;

export const modelRolesPoint = {
    name: "modelRoles",
    description:
        "The jobs this extension starts agent runs for, each of which the owner puts on a model setup in Sandbox ▸ Agent ▸ Models beside the sandbox's own: a run you start through `POST /agent` names its job as `job`, and runs on that setup's model when it names none of its own (an id the sandbox's own table held until 2026-11-26 may ride as `runRole`, which a sandbox from before reads too). Switching the extension off hides its jobs on that page and keeps the owner's choices for them.",
    schema: z.array(ModelRoleContributionSchema),
} as const satisfies ContributionPoint;
