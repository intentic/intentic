import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { endedUncleanly, type PreviousRun } from "../../../../system/boot/restarts/restart-record.js";
import { RESUME_ATTEMPTS_CEILING } from "../../../../store/journals/turn-journal.js";
import type { RestartResume } from "./restart-resume-policy.js";

/* ANOTHER RE-RUN FOR A TURN A SECOND RESTART CUT (2026-11-17, the shinobi-society audit). A cut turn gets one re-run, and
   the journal counts it before the re-run starts, so a turn whose own output kills the daemon (out of memory, again and
   again) cannot bring it down at every boot. Two restarts twelve minutes apart there cut the same turns twice; the
   second time they stood "not resumed: its one re-run is already spent" and the owner had to type Continue, although
   the re-run had been working the whole time and neither restart was its doing. One more re-run is earned when the cut
   one plainly was not the loop the cap guards against: it got real work done before it was cut, or the restart was one
   the sandbox announced for itself (an update, a restart someone asked for) and went through its own stop. Never past
   RESUME_ATTEMPTS_CEILING, and never for a restart memory caused, which holds its turns for the memory release on the
   strict count (memory-restart.ts). */

// Tool calls the cut re-run must have made to count as progress rather than a turn dying where it started.
const PROGRESS_TOOL_CALLS = 3;

// Who announces a restart that is nobody's turn's doing. The keeper is left out: it restarts a daemon that stopped
// answering, which a turn's own runaway can cause.
const ANNOUNCED_BY: ReadonlySet<string> = new Set(["owner", "daemon", "ic", "desktop"]);

// Whether the cut run made real progress: enough tool calls across what it drew.
const madeProgress = (drawn: readonly TranscriptRow[] | undefined): boolean =>
    (drawn ?? []).reduce((calls, row) => calls + (row.role === "assistant" ? (row.tools?.length ?? 0) : 0), 0) >= PROGRESS_TOOL_CALLS;

// Whether the restart was the sandbox's own: someone announced it, and the daemon went down through its own stop rather
// than being killed (a kill is how a turn's runaway ends a daemon, announced or not).
const sandboxOwn = (run: PreviousRun | undefined): boolean =>
    run !== undefined && !endedUncleanly(run.ended) && run.ended !== "crashed" && (run.graceful || (run.intent !== undefined && ANNOUNCED_BY.has(run.intent.by)));

/** Whether a cut turn whose first re-run is spent has earned another (see above). */
export const anotherRerunEarned = (
    entry: { readonly attempts: number },
    drawn: readonly TranscriptRow[] | undefined,
    resume: Pick<RestartResume, "memory">,
    run: PreviousRun | undefined,
): boolean => entry.attempts < RESUME_ATTEMPTS_CEILING && resume.memory === undefined && (madeProgress(drawn) || sandboxOwn(run));

/** Why a cut turn's re-runs are spent, in the words its line and its ledger row carry. */
export const rerunsSpentWhy = (attempts: number): string =>
    attempts >= RESUME_ATTEMPTS_CEILING ? `all ${String(RESUME_ATTEMPTS_CEILING)} of its re-runs are already spent` : "its one re-run is already spent, and the run it cut made too little progress to earn another";
