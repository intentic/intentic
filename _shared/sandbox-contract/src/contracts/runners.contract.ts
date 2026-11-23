import { procedure } from "../protocol/route-meta.js";
import { RunnerOpenViewInputSchema, RunnerViewSchema } from "../schemas/runner-views.js";

// What the editor asks about a conversation that runs on one of this sandbox's runners (schemas/runner-views.ts); the
// runner's own procedures are runner.contract.ts, which only this daemon calls. Withheld from the panel and control
// tokens: a person opens a view, never a program.
export const runnersContract = {
    openView: procedure
        .route({
            method: "POST",
            path: "/system/conversations/{conversationId}/runner-view",
            summary: "Open a live view of a conversation's runner",
            description:
                "Where a socket opens onto the terminal, a browser window or the desktop of the runner a conversation runs on, with a one-shot ticket. Maintainers only, for a conversation they may read, while its runner is connected.",
        })
        .meta({ panel: false, control: "never" })
        .input(RunnerOpenViewInputSchema)
        .output(RunnerViewSchema),
};
