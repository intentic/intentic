import { oc } from "@orpc/contract";
import { OkSchema, PrepushRunSchema } from "../schemas.js";

// The pre-push check — the command the workspace runs when the user pushes, before anything leaves the machine
// (see PrepushRunSchema for where this sits and why). Three verbs about ONE run: the check answers about the
// main working tree, of which there is exactly one, so nothing here is addressed by id.
//
// `run` starts the check and returns immediately — a suite takes minutes, and an oRPC call held open for one
// would die on the first proxy timeout with the work still going. The dialog that started it polls `state`,
// which carries the live output tail while `status` is `running`. `cancel` kills the child's whole process
// group; the run settles as `cancelled` and the push it was gating does not go.
export const prepushContract = {
    state: oc.route({ method: "GET", path: "/prepush/state" }).output(PrepushRunSchema),
    run: oc.route({ method: "POST", path: "/prepush/run" }).output(OkSchema),
    cancel: oc.route({ method: "POST", path: "/prepush/cancel" }).output(OkSchema),
};
