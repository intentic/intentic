import { oc } from "@orpc/contract";
import { ChoreLedgerWriteSchema, ChoreProbeRequestSchema, ChoresReportSchema } from "../schemas/maintenance.js";
import { OkSchema } from "../schemas/shared.js";

// Maintenance evidence across `list`/`probe`/`record`. No route runs a chore: a chore run is an ordinary isolated fleet
// agent (`POST /agent`), reusing its worktree, status, cost and transcript rather than duplicating a launcher here.
export const choresContract = {
    // Polled by both the rail badge and the panel.
    list: oc
        .route({
            method: "GET",
            path: "/chores",
            summary: "What maintenance the repos are asking for",
            description:
                "Every repo's standing evidence in one read: what the last measurement found and how old it is, the cheap signals that are always current, and what has already been decided about each.",
        })
        .output(ChoresReportSchema),
    probe: oc
        .route({
            method: "POST",
            path: "/chores/probe",
            summary: "Measure one repo again now",
            description:
                "Re-runs a single check without waiting for it to go stale. Answers immediately: the work happens in the background and the result turns up in the next read, because some of these sweeps outlive any sane request.",
        })
        .input(ChoreProbeRequestSchema)
        .output(OkSchema),
    // Also how a snooze is recorded, upserted the same way as a verdict.
    record: oc
        .route({
            method: "POST",
            path: "/chores/ledger",
            summary: "Record a verdict, or snooze one",
            description:
                "Writes what somebody concluded about one repo's chore, replacing the previous verdict. A chore has one current answer, not a growing pile of times it was fine.",
        })
        .input(ChoreLedgerWriteSchema)
        .output(OkSchema),
};
