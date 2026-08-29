import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import { IntenticRunSchema } from "../schemas/intentic.js";
import { OkSchema } from "../schemas/shared.js";

// Run the in-sandbox intentic CLI (resolve/plan/apply/deployments/…) and stream its ndjson lines as they
// arrive, so the UI sees live progress. A non-zero exit surfaces as a thrown error once the stream ends.
export const intenticContract = {
    run: oc
        .route({
            method: "POST",
            path: "/intentic",
            summary: "Run an infrastructure command",
            description:
                "Runs the sandbox's own command-line tool and streams its output as it arrives, so progress is visible rather than arriving all at once at the end. A failure surfaces once the stream closes.",
        })
        .input(IntenticRunSchema)
        .output(eventIterator(IntenticLineSchema)),
    // Launch the minutes-long apply → adopt reconcile as a one-shot tmux job (session panel-infra-apply) and
    // return immediately, progress is followed by attaching the terminal, not by holding this request open.
    apply: oc
        .route({
            method: "POST",
            path: "/intentic/apply",
            summary: "Bring the infrastructure into line",
            description:
                "Starts the long reconcile that makes the running world match what was declared, and answers immediately. It takes minutes, so it runs in a terminal you attach to rather than on a held-open request.",
        })
        .output(OkSchema),
    // Tail the running (or just-finished) apply's structured event stream, the same ndjson lines the tmux pane
    // renders as text, persisted to a durable file so the UI shows per-resource progress that survives a page
    // refresh. Replays from the run's {kind:"start"} then follows live, closing on {kind:"exit"}. GET, like
    // /events, because it takes no input; reuses the loose IntenticLine shape so no new schema is needed.
    applyEvents: oc
        .route({
            method: "GET",
            path: "/intentic/apply/events",
            summary: "Follow the reconcile",
            description:
                "The same progress the terminal shows, as structured events, kept on disk so a page refresh does not lose it. It replays from the start of the run and then follows live, closing when the run ends.",
        })
        .output(eventIterator(IntenticLineSchema)),
};
