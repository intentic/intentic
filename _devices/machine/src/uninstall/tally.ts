import { explain } from "@intentic/local-agent";
import type { Narration } from "../cli-ui.js";

/* WHAT A PURGE SAYS AS IT GOES, AND WHAT IT KEEPS COUNT OF FOR ITS ENDING. A step that does not finish is a warning
   with the command that finishes it by hand (`fix:` on its second line, read on a screen and in a log alike); only
   what leaves the agent on this device (still running, or its files still there) is a failure, which ends the run as
   the protocol's stop and exit 1. Everything else ends in one verdict, which counts the warnings. */

export interface Failure {
    readonly problem: string;
    readonly fix: string;
}

export interface Tally extends Narration {
    readonly warn: (sentence: string, fix?: string) => void;
    readonly fail: (problem: string, fix: string) => void;
    readonly warnings: () => number;
    readonly failures: () => readonly Failure[];
}

export const tally = (ui: Narration): Tally => {
    let warnings = 0;
    const failures: Failure[] = [];
    return {
        note: (text) => ui.note(text),
        warn: (sentence, fix) => {
            warnings += 1;
            ui.warn(fix === undefined ? sentence : explain(sentence, undefined, fix));
        },
        fail: (problem, fix) => {
            failures.push({ problem, fix });
        },
        warnings: () => warnings,
        failures: () => failures,
    };
};

/** The stop for what failed: one headline, then a problem/fix pair per failure, numbered when there are several. */
export const stopOf = (headline: string, failures: readonly Failure[]): string =>
    [
        headline,
        ...failures.flatMap((failure, at) => {
            const number = failures.length > 1 ? `${at + 1}. ` : "";
            return [`   problem: ${number}${failure.problem}`, `   fix:     ${failure.fix}`];
        }),
    ].join("\n");
