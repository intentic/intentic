import { oc } from "@orpc/contract";
import { ChoreLedgerWriteSchema, ChoreProbeRequestSchema, ChoresReportSchema, OkSchema } from "../schemas.js";

/* Maintenance evidence: what every repo under /work currently measures, and what has already been done about it.
 * Three routes, because there are exactly three things the surface does, read the evidence, ask for a
 * measurement to be retaken, and record what a turn concluded.
 *
 * There is no `GET /chores/{id}` and no "run this chore" route on purpose. A chore RUN is an ordinary isolated
 * fleet agent (`POST /agent` with a derived conversation id), the same as an acceptance run or a documentation
 * generation, so the worktree, the live status, the cost, the transcript and the /agents/<id> page already
 * exist, and adding a bespoke launcher here would be a second way to start a turn that has to be kept in step
 * with the first. */
export const choresContract = {
    // Every repo's standing evidence in one read: cached probe results (with their age and state), the cheap
    // resident signals, the ledger, and the daemon's node version. The rail badge polls this; so does the panel.
    list: oc
        .route({
            method: "GET",
            path: "/chores",
            summary: "What maintenance the repos are asking for",
            description:
                "Every repo's standing evidence in one read: what the last measurement found and how old it is, the cheap signals that are always current, and what has already been decided about each.",
        })
        .output(ChoresReportSchema),
    // Re-run one repo's probe now, ignoring its TTL, the panel's per-probe refresh. An ack: the runner works in
    // the background and the result arrives on the next `list`, because a jscpd sweep outlives any sane request.
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
    // Record what a chore turn concluded, or snooze one. Upsert by repo+chore: a chore has one current verdict,
    // and a growing history of "we looked at this and it was fine" is not something any reader wants paged.
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
