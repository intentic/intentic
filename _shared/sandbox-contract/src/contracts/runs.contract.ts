import { procedure } from "../protocol/route-meta.js";
import {
    DeviceRunsQuerySchema,
    DeviceRunsSchema,
    RUN_TARGETS_FILE,
    RunOutputQuerySchema,
    RunOutputSchema,
    RunStartedSchema,
    RunStartSchema,
    RunStopSchema,
    RunStoppedSchema,
    RunTargetsListSchema,
} from "../schemas/run-targets.js";

// A repository's programs run on the owner's own computers (schemas/run-targets.ts): what each repository declares, and
// the button that runs one. The run itself is `devices run` in a terminal, the same command an agent runs, so what the
// owner watches is what an agent gets; what it left running there is listed, read and stopped here.
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
                'Builds it in the sandbox, carries the build to the computer and starts it there, in a terminal you can watch. A run of the same target already going there is stopped first. The computer still decides: its "Run programs this sandbox sends" switch has to be on.',
        })
        .input(RunStartSchema)
        .output(RunStartedSchema),
    active: procedure
        .route({
            method: "GET",
            path: "/runs/active",
            summary: "What runs on one of your computers",
            description: "The programs this sandbox started on the computer, running and ended, as the computer reports them.",
        })
        .input(DeviceRunsQuerySchema)
        .output(DeviceRunsSchema),
    stop: procedure
        .route({
            method: "POST",
            path: "/runs/stop",
            summary: "Stop a target's run on one of your computers",
            description:
                "Ends the terminal it runs in and the program on the computer, with everything it started, and closes the ports the sandbox opened for it.",
        })
        .input(RunStopSchema)
        .output(RunStoppedSchema),
    output: procedure
        .route({
            method: "GET",
            path: "/runs/output",
            summary: "What a run on one of your computers printed",
            description: "The end of its log on the computer, or what it printed after an earlier read.",
        })
        .input(RunOutputQuerySchema)
        .output(RunOutputSchema),
};
