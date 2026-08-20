import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import { IntenticRunSchema, OkSchema } from "../schemas.js";

// Run the in-sandbox intentic CLI (resolve/plan/apply/deployments/…) and stream its ndjson lines as they
// arrive, so the UI sees live progress. A non-zero exit surfaces as a thrown error once the stream ends.
export const intenticContract = {
    run: oc.route({ method: "POST", path: "/intentic" }).input(IntenticRunSchema).output(eventIterator(IntenticLineSchema)),
    // Launch the minutes-long apply → adopt reconcile as a one-shot tmux job (session panel-infra-apply) and
    // return immediately, progress is followed by attaching the terminal, not by holding this request open.
    apply: oc.route({ method: "POST", path: "/intentic/apply" }).output(OkSchema),
    // Tail the running (or just-finished) apply's structured event stream, the same ndjson lines the tmux pane
    // renders as text, persisted to a durable file so the UI shows per-resource progress that survives a page
    // refresh. Replays from the run's {kind:"start"} then follows live, closing on {kind:"exit"}. GET, like
    // /events, because it takes no input; reuses the loose IntenticLine shape so no new schema is needed.
    applyEvents: oc.route({ method: "GET", path: "/intentic/apply/events" }).output(eventIterator(IntenticLineSchema)),
};
