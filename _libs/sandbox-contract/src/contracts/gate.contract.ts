import { oc } from "@orpc/contract";
import { GateVerdictSchema, OkSchema } from "../schemas.js";

// The landing gate — the check command run over the composite of landed work once the fleet goes quiet (see
// GateVerdictSchema for where this sits and why). Four verbs, all about ONE verdict: the gate answers about the
// main working tree, of which there is exactly one, so nothing here is addressed by id.
//
// `verdict` is the one read, and the panel polls it; it recomputes staleness per call, so a passed verdict stops
// claiming a green light the moment the tree moves under it. The three writes answer `ok` and nothing else —
// each starts work that outlives the request, so there is no result to return and the poll is what reports.
// `run` arms nothing and waits for nothing: it starts the check now, the user's own "I'm about to commit, check
// this". `fix` opens the seeded main-tree turn for a red verdict, the same shape /ci/fix opens for a red
// pipeline, minus the worktree it must not have.
export const gateContract = {
    verdict: oc.route({ method: "GET", path: "/gate/verdict" }).output(GateVerdictSchema),
    run: oc.route({ method: "POST", path: "/gate/run" }).output(OkSchema),
    cancel: oc.route({ method: "POST", path: "/gate/cancel" }).output(OkSchema),
    fix: oc.route({ method: "POST", path: "/gate/fix" }).output(OkSchema),
};
