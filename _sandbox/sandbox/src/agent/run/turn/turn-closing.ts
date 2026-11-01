import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { DomainEventMap } from "../../../seams/domain-events.js";
import type { TurnInput } from "../../../seams/turn-starter.js";
import { opt } from "../../../opt.js";
import { MAIN_MOVED_SOURCE } from "@intentic/sandbox-contract/events/agent-ui";
import { TURN_CHECKS_SOURCE } from "../turn-checks.js";

// What a settled turn ended on and how the bus hears of it (turn-runs.ts publishes it as `run.settled`).

const lastProse = (rows: readonly TranscriptRow[]): string =>
    rows.findLast((row) => row.role === "assistant" && row.text.trim() !== "")?.text.trim() ?? "";

// What a turn ended on, as its parent reads it. Where something was said back as it stopped (a notice row: the
// end-of-turn checks, or a main line its branch no longer rebased onto), the turn ended more than once: its report, then
// its answer to each. The answer alone used to stand as the whole report, and six children's reports reached their
// parent as replies to findings that were their siblings' (2026-10-17). The report leads; each answer follows it, named
// for what it answers.
const SAID_AT_STOP = new Map([
    [TURN_CHECKS_SOURCE, "On the end-of-turn checks"],
    [MAIN_MOVED_SOURCE, "On the main line that moved"],
]);

export const closingOf = (rows: readonly TranscriptRow[]): string => {
    const said = rows.flatMap((row, index) => {
        const label = row.role === "notice" ? SAID_AT_STOP.get(row.agentNotice?.source ?? "") : undefined;
        return label === undefined ? [] : [{ index, label }];
    });
    const last = lastProse(rows);
    const first = said[0];
    if (first === undefined) {
        return last;
    }
    const report = lastProse(rows.slice(0, first.index));
    const answers = said.flatMap(({ index, label }, at) => {
        const answer = lastProse(rows.slice(index + 1, said[at + 1]?.index));
        return answer === "" ? [] : [`${label}: ${answer}`];
    });
    if (report === "") {
        return last;
    }
    return [report, ...answers].join("\n\n");
};

// What the bus hears of a run that settled: who asked, how it ended, and what it ended on.
export const settledOf = (
    input: Pick<TurnInput, "actor" | "speaker"> & { readonly conversationId: string },
    rows: readonly TranscriptRow[],
    ended: { readonly run: string; readonly failure: string | undefined; readonly stopped: boolean; readonly rerun: { readonly at?: number } | undefined },
): DomainEventMap["run.settled"] => ({
    conversationId: input.conversationId,
    run: ended.run,
    actor: input.actor,
    speaker: input.speaker,
    failure: ended.failure,
    closing: closingOf(rows),
    ...opt("stopped", ended.stopped ? true : undefined),
    ...opt("rerun", ended.rerun),
});
