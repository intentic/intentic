import { agentException, createUi, explain, type Ui, type UiProcess } from "@intentic/local-agent";
import { buildCommand as stricliBuildCommand, type CommandContext, type StricliProcess } from "@stricli/core";
import { MACHINE_VERSION } from "./version.js";

/* WHAT EVERY intentic-machine COMMAND DRAWS THROUGH: the shared renderer (local-agent's ui.ts), one per run, so a
   failure settles the very step that was running as failed instead of opening a second renderer beside it. The shapes
   and words are docs/ops/cli-output-protocol.md. */

/**
 * The sandbox a setup is for, from whichever spelling named it: `--url`, or `--sandbox`, the flag every other command
 * picks a sandbox with. Both or neither is a stop that says which.
 */
export const sandboxUrlOf = (url: string | undefined, sandbox: string | undefined, failed: string): string => {
    if (url !== undefined && sandbox !== undefined && url !== sandbox) {
        throw new Error(explain(failed, `--url and --sandbox name two different sandboxes (${url}, ${sandbox}).`, "give one of them."));
    }
    const named = url ?? sandbox;
    if (named === undefined || named.trim() === "") {
        throw new Error(explain(failed, "no sandbox was named.", "pass --sandbox with the sandbox's address."));
    }
    return named;
};

/** What a helper narrates through while its caller's one live line runs. */
export type Narration = Pick<Ui, "note" | "warn">;

const opened = new WeakMap<object, Ui>();

/** This run's renderer, stamped with the agent's version; the same one for every caller in a run. */
export const machineUi = (process: UiProcess): Ui => {
    const known = opened.get(process);
    if (known !== undefined) {
        return known;
    }
    const ui = createUi(process, { stamp: `intentic-machine ${MACHINE_VERSION}` });
    opened.set(process, ui);
    return ui;
};

const aside = new WeakMap<object, Ui>();

/**
 * The renderer for a run that may answer `--json`: there stdout carries the one document and nothing else, so every
 * human line (narration, a live line, a stop) is drawn on stderr instead.
 */
export const answeringUi = (process: UiProcess, json: boolean): Ui => {
    if (!json) {
        return machineUi(process);
    }
    const known = aside.get(process);
    if (known !== undefined) {
        return known;
    }
    const ui = createUi(
        { stdout: process.stderr as UiProcess["stdout"], stderr: process.stderr, env: process.env },
        { stamp: `intentic-machine ${MACHINE_VERSION}` },
    );
    aside.set(process, ui);
    return ui;
};

/**
 * A thrown error ends the run as the protocol's stop: the Stop block on a terminal, `error: <message>` as the first
 * stderr line on a pipe (the desktop app shows what follows `error: `), and exit 1. Done here rather than in stricli's
 * `exceptionWhileRunningCommand`, which can only return a string that stricli then prints on a line of its own.
 */
export const failRun = (context: CommandContext, error: unknown): void => {
    machineUi(context.process).fail(agentException(error));
    markFailed(context);
};

/** Exit 1 for this run, whatever drew the failure (a stop, or a --json `{ ok: false }`). */
export const markFailed = (context: CommandContext): void => {
    // stricli types a command's process as its two streams, but runs it with the whole StricliProcess, whose exit code
    // `run` keeps (`exitCode ??= …`) over the success it would otherwise record.
    (context.process as StricliProcess).exitCode = 1;
};

/** stricli's buildCommand, with every local command's failure ending as a stop (failRun). */
export const buildCommand = ((builder: Parameters<typeof stricliBuildCommand>[0]) => {
    if (!("func" in builder)) {
        return stricliBuildCommand(builder);
    }
    const inner = builder.func;
    return stricliBuildCommand({
        ...builder,
        async func(this: CommandContext, ...args: Parameters<typeof inner>) {
            try {
                return await inner.apply(this, args);
            } catch (error) {
                failRun(this, error);
                return undefined;
            }
        },
    });
}) as typeof stricliBuildCommand;
