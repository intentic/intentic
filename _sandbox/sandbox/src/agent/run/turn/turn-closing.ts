import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { DomainEventMap } from "../../../seams/domain-events.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { opt } from "../../../opt.js";
import { TURN_CHECKS_SOURCE } from "../turn-checks.js";

// What a settled turn ended on and how the bus hears of it (turn-runs.ts publishes it as `run.settled`).

const lastProse = (rows: readonly TranscriptRow[]): string =>
    rows.findLast((row) => row.role === "assistant" && row.text.trim() !== "")?.text.trim() ?? "";

// What a turn ended on, as its parent reads it. Where the end-of-turn checks were said back (their notice row), the turn
// ended twice: its report, then its answer to the checks. The answer alone used to stand as the whole report, and six
// children's reports reached their parent as replies to findings that were their siblings' (2026-10-17). The report
// leads; the answer follows it, named for what it is.
export const closingOf = (rows: readonly TranscriptRow[]): string => {
    const said = rows.findLastIndex((row) => row.role === "notice" && row.agentNotice?.source === TURN_CHECKS_SOURCE);
    const last = lastProse(rows);
    if (said === -1) {
        return last;
    }
    const report = lastProse(rows.slice(0, said));
    const answer = lastProse(rows.slice(said + 1));
    if (report === "" || answer === "") {
        return report === "" ? last : report;
    }
    return `${report}\n\nOn the end-of-turn checks: ${answer}`;
};

// What the bus hears of a run that settled: who asked, how it ended, and what it ended on.
export const settledOf = (
    input: Pick<TurnInput, "actor" | "speaker"> & { readonly conversationId: string },
    rows: readonly TranscriptRow[],
    ended: { readonly failure: string | undefined; readonly stopped: boolean; readonly rerun: { readonly at?: number } | undefined },
): DomainEventMap["run.settled"] => ({
    conversationId: input.conversationId,
    actor: input.actor,
    speaker: input.speaker,
    failure: ended.failure,
    closing: closingOf(rows),
    ...opt("stopped", ended.stopped ? true : undefined),
    ...opt("rerun", ended.rerun),
});
