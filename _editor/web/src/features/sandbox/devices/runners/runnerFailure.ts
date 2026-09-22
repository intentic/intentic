import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { runnerFallback } from "./deviceFallback";
import { DeviceFlowLostError } from "../useDevices";

export type RunnerOp = "create" | "remove" | "update";

/** A runner press that didn't take: the notice, and the line that does the same thing on the machine itself. */
export interface RunnerFailure {
    readonly notice: NoticeModel;
    readonly command?: string;
}

// What didn't happen, naming the runner and the machine; the reason rides underneath in its giver's own words.
const NOT_DONE: Record<RunnerOp, (name: string, machine: string) => string> = {
    create: (name, machine) => `Runner "${name}" wasn't added to ${machine}.`,
    remove: (name, machine) => `Runner "${name}" wasn't removed from ${machine}.`,
    update: (name, machine) => `Runner "${name}" wasn't updated on ${machine}.`,
};

// Adding and updating leave `ic`'s own log of the run on the machine; removing is a docker call with nothing to keep.
const WHILE: Record<RunnerOp, { readonly doing: string; readonly after: (machine: string) => string }> = {
    create: {
        doing: `adding`,
        after: (machine) =>
            `It may still be running there: the runner joins this list once it enrolls, and ${machine} keeps a full log of the attempt in ~/.intentic/logs.`,
    },
    update: {
        doing: `updating`,
        after: (machine) => `It may still be running there: this list catches up once it's done, and ${machine} keeps a full log of the attempt in ~/.intentic/logs.`,
    },
    remove: { doing: `removing`, after: () => `It may still be running there: this list catches up once it's done.` },
};

// A refusal quotes every line the machine streamed, and those stay on screen above it: only what they don't say is repeated.
const unstreamed = (said: string, streamed: readonly string[]): string | undefined => {
    const shown = new Set(streamed);
    const rest = said
        .split(`\n`)
        .filter((line) => !shown.has(line))
        .join(`\n`)
        .trim();
    return rest === `` ? undefined : rest;
};

/**
 * The notice for a runner op that threw. A dropped stream is the machine carrying on with nobody listening, so it is
 * said as that rather than as a failure, and with no line to type: the act may be finishing out there as this is read.
 */
export const runnerFailure = (op: RunnerOp, name: string, machine: string, error: unknown, streamed: readonly string[]): RunnerFailure => {
    if (error instanceof DeviceFlowLostError) {
        const browser = error.transport === undefined ? `` : ` The browser said: "${error.transport}".`;
        return {
            notice: {
                tone: `warning`,
                title: `Lost contact with ${machine} while ${WHILE[op].doing} runner "${name}".`,
                detail: `${WHILE[op].after(machine)}${browser}`,
            },
        };
    }
    const notice = noticeFrom(error, NOT_DONE[op](name, machine));
    return {
        notice: { ...notice, detail: notice.detail === undefined ? undefined : unstreamed(notice.detail, streamed) },
        command: runnerFallback(op, name),
    };
};
