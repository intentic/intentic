import { rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { writeFileAtomicSync } from "@intentic/base/fs";
import type { BootProgress } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { version } from "../../version.js";
import { type Teardown, tearDown } from "./daemon-stop.js";

// Why the last boot on this volume failed before it could serve, left by the daemon that failed just before it exits
// (main.ts), for the host: `ic` reads it with `docker exec cat` when a sandbox it started never comes up, and says why
// instead of watching a restart loop. The next boot that reaches its readiness gate removes it, so its presence means
// the most recent boot failed. Declared so its shape is frozen; nothing in the daemon reads it back.
const BootFailureSchema = z.object({
    at: z.number(),
    // This build's version, so a failure is pinned on the release that had it.
    version: z.string(),
    // The error's message and the first lines of its stack.
    error: z.string(),
    // The boot step (or, before the steps, the stage of boot) it failed in, when known.
    step: z.string().optional(),
});
export type BootFailure = z.infer<typeof BootFailureSchema>;
export const bootFailureDocument = defineDocument({ root: "history", path: "boot-failure.json", boot: false, schema: BootFailureSchema });

// Enough of the stack to name the module that threw, few enough for a host's one-line report.
const STACK_LINES = 6;

// The message and the first lines of the stack under it (a V8 stack starts with the message).
export const describeBootError = (error: Error): string => {
    const stack = error.stack ?? `${error.name}: ${error.message}`;
    return stack
        .split("\n")
        .slice(0, 1 + STACK_LINES)
        .join("\n");
};

// Synchronous, since the process exits right after; written beside and renamed over, so the host never reads half.
// Into the history volume as it is: a root that does not exist is no volume a host reads, so none is made for it.
export const recordBootFailure = (historyRoot: string, failure: BootFailure): void => {
    writeFileAtomicSync(join(historyRoot, bootFailureDocument.path), `${JSON.stringify(failure, undefined, 2)}\n`);
};

// Never throws: the boot this follows has already succeeded, and a record left behind is only stale news.
export const clearBootFailure = async (historyRoot: string, logger: Pick<Logger, "warn">): Promise<void> => {
    try {
        await rm(join(historyRoot, bootFailureDocument.path), { force: true });
    } catch (error) {
        logger.warn({ err: error }, "boot: the last boot's failure record could not be removed");
    }
};

// What a boot that fails before its gate opens can say about itself, filled in by main.ts as boot gets further.
export interface BootAttempt {
    // Where boot had got to, for a failure outside the boot chain's own named steps.
    stage: string;
    // Where the record goes: the configured history volume once the configuration is read.
    historyRoot: string;
    logger?: Pick<Logger, "fatal">;
    // Unset until the container is claimed: a failure before that is the host's own daemon's.
    role?: { readonly container: boolean };
    // The boot chain's tracker, once the services exist: it names the step that failed.
    services?: { readonly boot: { readonly progress: () => BootProgress } };
    // What had started, stopped before the exit as a SIGTERM would.
    shutdown?: Teardown;
}

// The boot step that failed, when the chain's own tracker saw it: more exact than the stage around it. The last one, since
// a tolerated step can read failed ahead of the fatal one that stopped the chain.
const failedStep = (attempt: BootAttempt): string | undefined =>
    attempt.services?.boot.progress().steps.findLast((step) => step.state === "failed")?.label;

// Records why this boot failed where the host looks, logs it, and exits non-zero so netd restarts the daemon with
// backoff. Only the daemon that owns the container records anything: a second daemon sharing the volume is not the one
// the host started. What had started is stopped first, so a restart finds nothing of it running.
export const failBoot = async (attempt: BootAttempt, error: Error, exit: (code: number) => never = process.exit): Promise<never> => {
    const step = failedStep(attempt) ?? attempt.stage;
    const { logger } = attempt;
    // Before the logger exists (a configuration that would not load), stderr is what `docker logs` keeps.
    const say = (message: string, detail: string): void => {
        if (logger === undefined) {
            process.stderr.write(`${message}: ${detail}\n`);
        } else {
            logger.fatal({ step, detail }, message);
        }
    };
    if (logger === undefined) {
        say("boot: failed before the daemon was ready; exiting so it is started again", describeBootError(error));
    } else {
        logger.fatal({ err: error, step }, "boot: failed before the daemon was ready; exiting so it is started again");
    }
    if (attempt.historyRoot !== "" && attempt.role?.container !== false) {
        try {
            recordBootFailure(attempt.historyRoot, { at: Date.now(), version, error: describeBootError(error), step });
        } catch (recordError) {
            say("boot: the failure could not be recorded on the history volume", errorMessage(recordError));
        }
    }
    const unstopped = attempt.shutdown === undefined ? undefined : await tearDown(attempt.shutdown);
    if (unstopped !== undefined) {
        say("boot: one or more subsystems did not stop cleanly after the boot failed", unstopped);
    }
    return exit(1);
};
