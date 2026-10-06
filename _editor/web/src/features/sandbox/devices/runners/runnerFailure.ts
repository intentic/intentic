import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
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
    create: (name, machine) => t(`sandbox.runnerFailure.notAdded`, { name, machine }),
    remove: (name, machine) => t(`sandbox.runnerFailure.notRemoved`, { name, machine }),
    update: (name, machine) => t(`sandbox.runnerFailure.notUpdated`, { name, machine }),
};

// Adding and updating leave `ic`'s own log of the run on the machine; removing is a docker call with nothing to keep.
const WHILE: Record<RunnerOp, { readonly lost: (name: string, machine: string) => string; readonly after: (machine: string) => string }> = {
    create: {
        lost: (name, machine) => t(`sandbox.runnerFailure.lostAdding`, { name, machine }),
        after: (machine) => t(`sandbox.runnerFailure.afterAdding`, { machine }),
    },
    update: {
        lost: (name, machine) => t(`sandbox.runnerFailure.lostUpdating`, { name, machine }),
        after: (machine) => t(`sandbox.runnerFailure.afterUpdating`, { machine }),
    },
    remove: {
        lost: (name, machine) => t(`sandbox.runnerFailure.lostRemoving`, { name, machine }),
        after: () => t(`sandbox.runnerFailure.afterRemoving`),
    },
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
        const after = WHILE[op].after(machine);
        return {
            notice: {
                tone: `warning`,
                title: WHILE[op].lost(name, machine),
                detail: error.transport === undefined ? after : `${after} ${t(`sandbox.runnerFailure.browserSaid`, { transport: error.transport })}`,
            },
        };
    }
    const notice = noticeFrom(error, NOT_DONE[op](name, machine));
    return {
        notice: { ...notice, detail: notice.detail === undefined ? undefined : unstreamed(notice.detail, streamed) },
        command: runnerFallback(op, name),
    };
};
