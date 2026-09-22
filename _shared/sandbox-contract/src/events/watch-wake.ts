import type { TranscriptRow, TranscriptWatchWake, WatchOutcome } from "./transcript.js";

// What a condition watch says when it wakes a conversation, and how that reads to a person. The wake is delivered as an
// ordinary turn prompt, so composing it and recognising it must stay one piece of knowledge: three separate readers
// (the daemon's record, a steered live turn, a provider's session store) turn that prompt back into a row.

// Per-outcome opening sentence, which is also what the parser anchors on: keep each unique and stable across releases,
// or a reworded opening un-recognises wakes already in a record and they read as the user's own words again.
const OPENINGS: Record<WatchOutcome, string> = {
    met: "Watch fired: the condition you were watching is now met.",
    timeout: "Watch timed out: the deadline passed and the check never exited 0. Decide whether to re-arm it, investigate the check, or report back.",
    "restart-expired":
        "Watch stopped: its deadline passed while the daemon was restarting, so it went unchecked for part of that window. It has just been re-checked once and the condition still does not hold. Decide whether to re-arm it, investigate the check, or report back.",
    broken: "Watch stopped: its check can no longer run at all, so it was disarmed rather than left waiting on a condition it could never see. The reason is in the output below. Decide whether to re-arm it with a check that can run, or report back.",
};

// Labels the prompt writes and the parser reads back. `Watching` and `Elapsed` are load-bearing on both sides; the rest
// are for the model and the reader only.
const WATCHING = "Watching: ";
const ELAPSED = "Elapsed: ";

export interface WatchWakeFields {
    readonly outcome: WatchOutcome;
    readonly id: string;
    readonly note: string;
    readonly elapsed: string;
    readonly command: string;
    // Undefined when the check never exited on its own (killed at its timeout, or failed to spawn).
    readonly exitCode: number | undefined;
    readonly output: string;
}

// The prompt a wake actually sends. The watch id sits in the body rather than the opening: it is the handle for
// `watch stop`, so it has to be here, but it is the least useful thing on the page to read first.
export const watchWakePrompt = (fields: WatchWakeFields): string =>
    [
        OPENINGS[fields.outcome],
        `${WATCHING}${fields.note}`,
        `${ELAPSED}${fields.elapsed}`,
        `Watch id: ${fields.id}`,
        `Check command: ${fields.command}`,
        `Last exit code: ${fields.exitCode === undefined ? "none (check was killed or failed to start)" : fields.exitCode}`,
        ...(fields.output === "" ? [] : ["Last output (tail):", "```", fields.output, "```"]),
        "Continue the task this watch was armed for.",
    ].join("\n");

// The one line a person reads. Present tense for the ending itself, since the row appears the moment it happens.
const headline = (outcome: WatchOutcome, note: string, elapsed: string): string => {
    if (outcome === "met") {
        return `${note} — the watch fired after ${elapsed}.`;
    }
    if (outcome === "timeout") {
        return `${note} — the watch gave up after ${elapsed}.`;
    }
    if (outcome === "broken") {
        return `${note} — the watch stopped after ${elapsed}: its check can no longer run.`;
    }
    return `${note} — the watch stopped when the sandbox restarted, after ${elapsed}.`;
};

const valueOn = (lines: readonly string[], label: string): string | undefined => lines.find((line) => line.startsWith(label))?.slice(label.length);

// Which wake a stored prompt is, if any; undefined for every prompt that isn't one, so any reader can ask without
// checking first. A prompt that opens as a wake but lost its labelled lines is not one: half-parsing it would put a
// blank note on the row and lose the words with it.
export const watchWakeOf = (prompt: string): TranscriptWatchWake | undefined => {
    const outcome = (Object.keys(OPENINGS) as WatchOutcome[]).find((key) => prompt.startsWith(OPENINGS[key]));
    if (outcome === undefined) {
        return undefined;
    }
    const lines = prompt.split("\n");
    const note = valueOn(lines, WATCHING);
    const elapsed = valueOn(lines, ELAPSED);
    return note === undefined || elapsed === undefined ? undefined : { outcome, note, elapsed, sent: prompt };
};

// The row a wake becomes, wherever a prompt is turned into rows: a notice, because a watch firing is something that
// happened to the turn rather than anything either side said. Undefined when the prompt is not a wake at all.
export const watchWakeRow = (prompt: string): TranscriptRow | undefined => {
    const wake = watchWakeOf(prompt);
    return wake === undefined ? undefined : { role: "notice", text: headline(wake.outcome, wake.note, wake.elapsed), watchWake: wake };
};
