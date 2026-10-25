import { resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { TURN_CHECKS_SOURCE } from "@intentic/sandbox-contract/events/agent-ui";
import type { AgentRequest } from "../../agent/providers/agent-request.js";
import { type TurnCheckReport, turnCheckReports, turnChecksNote, turnChecksNotice } from "../../agent/run/turn-checks.js";

/* WHAT EVERY LOOP HEARS AS ITS TURN ENDS, WHATEVER LOOP IT IS.

   The repositories' `turn` checks (agent/run/turn-checks.ts) and, for a loop with no hook after a call
   (AgentCapabilities.editChecks "turn-end"), the owner's per-edit checks on the files its edit calls touched. What they
   found goes back to the loop as one more prompt on the same session, which it fixes or answers, as the Claude Code loop
   hears it from its Stop hook and Codex from its gate's stop. Once per turn, never after a run that failed or was
   stopped, and nothing waits on them past that one prompt. 2026-10-25: before this only Claude Code, Codex and Pi heard
   either, so a Cursor, OpenCode, Muse or ACP turn ended past a failing check the owner's repository declared. */

// One more prompt on the session the run ended on: the loop's own way of sending a message, plan mode off.
export type FollowUp = (note: string, sessionId: string | undefined) => AsyncGenerator<AgentEvent, unknown>;

// How a loop's turn ends: how it is told what the checks found, and whether its own hooks already said the edit checks.
export interface TurnEnding {
    readonly followUp: FollowUp;
    readonly editChecks: AgentCapabilities["editChecks"];
}

// What the run's own frames said: whether it failed, the session it ran on, and the files each edit call touched.
interface RunReading {
    failed: boolean;
    sessionId: string | undefined;
    readonly edits: Map<string, readonly string[]>;
}

type ToolFrame = Extract<AgentEvent, { kind: "tool_call" | "tool_call_update" }>;

// The workspace paths a tool frame names: its locations and the files its diffs change.
const pathsOf = (frame: ToolFrame): string[] => [
    ...(frame.locations ?? []).map(({ path }) => path),
    ...(frame.content ?? []).flatMap((block) => (block.type === "diff" ? [block.path] : [])),
];

const take = (reading: RunReading, event: AgentEvent): void => {
    if (event.kind === "error") {
        reading.failed = true;
    } else if (event.kind === "session") {
        reading.sessionId = event.sessionId;
    } else if (event.kind === "tool_call" && event.category === "edit") {
        reading.edits.set(event.id, pathsOf(event));
    } else if (event.kind === "tool_call_update" && reading.edits.has(event.id)) {
        // A call that failed changed nothing; a later snapshot of its files replaces the earlier one.
        const paths = pathsOf(event);
        if (event.status === "failed") {
            reading.edits.delete(event.id);
        } else if (paths.length > 0) {
            reading.edits.set(event.id, paths);
        }
    }
};

// The owner's per-edit checks on every file the turn's edit calls touched, resolved where the loop ran. A check that
// cannot run is said, not swallowed: the model should not read silence as a clean file.
const editNotes = async (request: Pick<AgentRequest, "spec" | "hooks">, reading: RunReading): Promise<string[]> => {
    const reviewers = request.hooks.editReviewers ?? [];
    const files = [...new Set([...reading.edits.values()].flat())];
    const notes: string[] = [];
    for (const file of reviewers.length === 0 ? [] : files) {
        for (const reviewer of reviewers) {
            const note = await reviewer(resolve(request.spec.cwd, file), "this turn's edits").catch(
                (error: Parameters<typeof errorMessage>[0]) => `An edit check could not run on ${file}: ${errorMessage(error)}`,
            );
            if (note !== undefined && note !== "") {
                notes.push(note);
            }
        }
    }
    return notes;
};

// The repositories' turn checks that did not pass; none when they cannot be run, which costs the turn one log line.
const turnReports = async (request: Pick<AgentRequest, "hooks">): Promise<TurnCheckReport[]> => {
    const checks = request.hooks.turnChecks;
    if (checks === undefined || checks.rules.length === 0) {
        return [];
    }
    try {
        return await turnCheckReports(checks);
    } catch (error) {
        // Never a failed turn: a check that cannot be run is no reason to keep the turn from ending.
        checks.logger.warn({ err: error }, "turn checks: could not run the repositories' turn checks, so the turn ends without them");
        return [];
    }
};

// The notice row and what the loop is told: one row under the turn checks' own source, whichever spoke, since that row is
// the boundary a parent reads the turn's report from (agent/run/turn/turn-closing.ts closingOf).
const endingOf = (reports: readonly TurnCheckReport[], edits: readonly string[]): { readonly notice: AgentEvent; readonly note: string } | undefined => {
    const editNote = edits.length === 0 ? undefined : `The owner's edit checks on the files this turn changed:\n\n${edits.join("\n\n")}`;
    const turnNote = reports.length === 0 ? undefined : turnChecksNote(reports);
    const note = [turnNote, editNote].filter((part): part is string => part !== undefined).join("\n\n");
    if (note === "") {
        return undefined;
    }
    const notice: AgentEvent =
        reports.length > 0
            ? turnChecksNotice(reports, note)
            : { kind: "agent_notice", level: "info", source: TURN_CHECKS_SOURCE, text: "Edit checks had notes on the files this turn changed. Sent to the agent.", sent: note };
    return { notice, note };
};

/** `run`, then what the checks found on the turn's change said back through `ending.followUp`, once. */
export async function* withEndingChecks(
    request: Pick<AgentRequest, "spec" | "signal" | "hooks">,
    run: AsyncGenerator<AgentEvent, unknown>,
    ending: TurnEnding,
): AsyncGenerator<AgentEvent> {
    const reading: RunReading = { failed: false, sessionId: undefined, edits: new Map() };
    for await (const event of run) {
        take(reading, event);
        yield event;
    }
    if (reading.failed || request.signal.aborted) {
        return;
    }
    const reports = await turnReports(request);
    const edits = ending.editChecks === "turn-end" ? await editNotes(request, reading) : [];
    const said = request.signal.aborted ? undefined : endingOf(reports, edits);
    if (said === undefined) {
        return;
    }
    yield said.notice;
    yield* ending.followUp(said.note, reading.sessionId ?? request.spec.sessionId);
}
