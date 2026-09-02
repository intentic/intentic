import { oc } from "@orpc/contract";
import { CommandRunSchema } from "../schemas/ci.js";
import { OkSchema } from "../schemas/shared.js";

// The pre-push check, the command the workspace runs when the user pushes, before anything leaves the machine
// (see CommandRunSchema for where this sits and why). Three verbs about ONE run: the check answers about the
// main working tree, of which there is exactly one, so nothing here is addressed by id.
//
// `run` starts the check and returns immediately, a suite takes minutes, and an oRPC call held open for one
// would die on the first proxy timeout with the work still going. The dialog that started it polls `state` for
// the verdict, and opens the terminals panel on the `session` the first answer names: the suite runs in a real
// tmux window, so watching it is the terminal's job. `cancel` kills that window; the run settles as `cancelled`
// and the push it was gating does not go.
export const prepushContract = {
    state: oc
        .route({
            method: "GET",
            path: "/prepush/state",
            summary: "How the pre-push check is going",
            description:
                "The verdict, or the progress so far. Nothing is addressed by id here, because there is one working tree and so exactly one check.",
        })
        .output(CommandRunSchema),
    run: oc
        .route({
            method: "POST",
            path: "/prepush/run",
            summary: "Run the checks before pushing",
            description:
                "Starts the suite the workspace runs before anything leaves the machine, and answers immediately. A suite takes minutes, and a request held open that long dies at the first proxy. It runs in a real terminal, so watch it there and poll for the verdict.",
        })
        .output(OkSchema),
    cancel: oc
        .route({
            method: "POST",
            path: "/prepush/cancel",
            summary: "Stop the pre-push check",
            description: "Kills the run. It settles as cancelled and the push it was gating does not go.",
        })
        .output(OkSchema),
};
