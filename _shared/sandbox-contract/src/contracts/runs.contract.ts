import { procedure } from "../protocol/route-meta.js";
import { RUN_TARGETS_FILE, RunStartedSchema, RunStartSchema, RunTargetsListSchema } from "../schemas/run-targets.js";

// A repository's programs run on the owner's own computers (schemas/run-targets.ts): what each repository declares, and
// the button that runs one. The run itself is `devices run` in a terminal, the same command an agent runs, so what the
// owner watches is what an agent gets.
export const runsContract = {
    targets: procedure
        .route({
            method: "GET",
            path: "/runs/targets",
            summary: "What each repository can run on your computers",
            description: `Every repository that declares run targets at \`${RUN_TARGETS_FILE}\`, and which of your computers could run one now.`,
        })
        .output(RunTargetsListSchema),
    start: procedure
        .route({
            method: "POST",
            path: "/runs/start",
            summary: "Run a target on one of your computers",
            description:
                "Builds it in the sandbox, carries the build to the computer and starts it there, in a terminal you can watch. The computer still decides: its \"Run programs this sandbox sends\" switch has to be on.",
        })
        .input(RunStartSchema)
        .output(RunStartedSchema),
};
