import { resolve } from "node:path";
import { queueArgs } from "@intentic/constants/heavy-rules";
import type { ExtensionExec, ExtensionExecResult } from "@intentic/sandbox-contract/extension-protocol";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { childEnv } from "../../workload/child-env.js";
import { heavyEnvVariables, QUEUE_RUN_BIN, queueRunEnabled } from "../../workload/heavy-commands.js";
import { WAIT_DEADLINE_MS } from "../../workload/resource-budget.js";
import { runCheck } from "../../workload/run-check.js";

// AN EXTENSION'S COMMAND UNDER THE SANDBOX'S WORKLOAD ADMISSION (2026-11-26): `api.exec`, behind POST /extension/exec
// (own.routes.ts), for the class its manifest declares (`permissions.exec`). An extension's backend can spawn a process
// itself, and before this one did, so a code-health probe run competed with every build on the machine instead of taking
// its turn. Here it is admitted the way the daemon's own background work is:
// - `toolchain`: a heavy tool. It runs under queue-run with the heavy-command table's pool, limit and memory gate, so it
//   takes a slot beside every agent's builds and tests and waits for room priced as a toolchain command, the reservation
//   handed back the moment it exits. Where the queue is off or not installed, the memory budget admits it here instead.
// - `command`: admitted by the memory budget as an agent's shell command is, and ranked like one.
// Either way it runs in its class (CPU, IO and the OOM killer's rank), in a process group of its own stamped with its
// deadline for the reaper, and every program it starts is judged by the heavy-command table as it starts, as an agent's
// line is: a build it runs queues by itself. A queued run's stderr opens with queue-run's own lines while it waits.

export type ExecDeps = Pick<Services, "resources" | "heavyCommands" | "workspace">;

// Where queue-run is, when heavy commands may queue at all here.
const queueRunHere = (): string | undefined => (queueRunEnabled() ? QUEUE_RUN_BIN : undefined);

/** Runs one command for `extension` (its publisher.name) to its end, its deadline, or `signal`; never rejects. */
export const runExtensionExec = async (
    deps: ExecDeps,
    extension: string,
    spec: ExtensionExec,
    signal: AbortSignal,
    queueRun: string | undefined = queueRunHere(),
): Promise<ExtensionExecResult> => {
    const heavy = await deps.heavyCommands.read();
    const label = spec.label === undefined ? `extension:${extension}` : `extension:${extension}:${spec.label}`;
    const queued = spec.class === "toolchain" && heavy.queue && queueRun !== undefined ? queueRun : undefined;
    let waitedMs = 0;
    if (queued === undefined) {
        const admission = await deps.resources.admit({
            workload: spec.class,
            attended: false,
            where: "local",
            wait: { deadlineMs: Math.min(spec.timeoutMs, WAIT_DEADLINE_MS), signal },
        });
        if (admission.verdict !== "run") {
            return { refused: admission.message, waitedMs: admission.waitedMs, stdout: "", stderr: "", truncated: false };
        }
        waitedMs = admission.waitedMs;
    }
    const argv =
        queued === undefined
            ? spec.argv
            : [queued, ...queueArgs({ id: label, pool: heavy.defaultPool, limit: heavy.limit, maxHold: heavy.maxHoldSeconds, onDeadline: "run" }, heavy), "--", ...spec.argv];
    const inherited = childEnv({ ...process.env, ...spec.env });
    try {
        const ran = await runCheck({
            argv,
            cwd: resolve(deps.workspace.root, spec.cwd ?? "."),
            env: { ...inherited, ...heavyEnvVariables(heavy, { queueRun }, inherited) },
            timeoutMs: spec.timeoutMs,
            signal,
            workload: { class: spec.class },
            kind: "extension-exec",
            captureBytes: spec.outputBytes,
            ...opt("keep", spec.keep),
            ...opt("stdin", spec.stdin),
        });
        return {
            waitedMs,
            ...opt("exitCode", ran.exitCode),
            ...opt("signal", ran.exitSignal),
            stdout: ran.stdout,
            stderr: ran.stderr,
            truncated: ran.truncated,
            // Overflow never ends it here (no killOnOverflow): the stream is still read, and `truncated` says so.
            ...opt("ended", ran.ended === "overflow" ? undefined : ran.ended),
            ...opt("spawnError", ran.spawnError),
        };
    } finally {
        // What it held is free again: work waiting for room looks now rather than at its next interval.
        deps.resources.changed();
    }
};
