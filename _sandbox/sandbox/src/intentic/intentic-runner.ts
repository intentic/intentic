import { spawn } from "node:child_process";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { whenAborted } from "../abort.js";
import { DAEMON_OWNER, workloadStamp } from "../platform/boot/leftovers.js";

// IntenticLine, one parsed line from `intentic ... --output ndjson`, is the wire shape the daemon streams; it lives in
// @intentic/sandbox-contract. Decoupled from @intentic/engine on purpose: the sandbox runs a pinned intentic binary in
// a separate process and only consumes this wire shape.

// Parses one ndjson line; blank, non-object, or no string `kind` yields undefined. Malformed JSON throws, a real
// contract violation.
export const parseIntenticLine = (line: string): IntenticLine | undefined => {
    const trimmed = line.trim();
    if (trimmed === "") {
        return undefined;
    }
    const value = JSON.parse(trimmed) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
    }
    const kind = (value as { kind?: unknown }).kind;
    return typeof kind === "string" ? (value as IntenticLine) : undefined;
};

// Splits arbitrary string chunks into newline-delimited lines, carrying a partial line across chunk boundaries and
// flushing any remainder at the end.
export async function* chunksToLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
    let buffer = "";
    for await (const chunk of chunks) {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index !== -1) {
            yield buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            index = buffer.indexOf("\n");
        }
    }
    if (buffer !== "") {
        yield buffer;
    }
}

export interface IntenticRun {
    // Subcommand + flags, e.g. ["resolve", "--config", ...]; INTENTIC_OUTPUT=ndjson is forced regardless.
    readonly args: readonly string[];
    readonly cwd: string;
}

// Ceiling on a streamed run: healthy resolve/plan finish fast, so surviving this means wedged, not working.
const RUN_WATCHDOG_MS = 10 * 60_000;

// The slice of a pino logger the runner needs, structural, so tests pass a plain recorder.
export interface RunLogger {
    readonly info: (fields: object, message: string) => void;
    readonly warn: (fields: object, message: string) => void;
}

// Runs the CLI and streams its ndjson lines live; a non-zero exit throws after the stream ends, with captured stderr.
// The child is killed on abort, teardown or the watchdog; full lifecycle logs make a crashed run attributable from
// daemon.log alone.
export async function* runIntentic(run: IntenticRun, signal?: AbortSignal, logger?: RunLogger): AsyncGenerator<IntenticLine> {
    const startedAt = Date.now();
    // Daemon-owned stamp for the one case that can't self-kill: a daemon replaced mid-run, orphaning the child.
    const child = spawn("intentic", [...run.args], {
        cwd: run.cwd,
        env: { ...process.env, INTENTIC_OUTPUT: "ndjson", ...workloadStamp(DAEMON_OWNER) },
    });
    logger?.info({ args: run.args, pid: child.pid }, "intentic run spawned");
    child.stdout.setEncoding("utf8");
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    // SIGTERM first (the CLI's handlers release apply locks), SIGKILL for a child that ignores it.
    let killedBy: string | undefined;
    const kill = (reason: string): void => {
        killedBy ??= reason;
        logger?.warn({ args: run.args, pid: child.pid, reason, elapsedMs: Date.now() - startedAt }, "intentic run killed");
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const onAbort = (): void => kill("the client disconnected");
    // Catches a signal aborted before spawn finished; a bare listener misses it until the watchdog fires.
    const unwatchAbort = whenAborted(signal, onAbort);
    const watchdog = setTimeout(() => kill(`the run exceeded ${RUN_WATCHDOG_MS / 60_000}m`), RUN_WATCHDOG_MS);
    watchdog.unref();
    try {
        for await (const line of chunksToLines(child.stdout as AsyncIterable<string>)) {
            const parsed = parseIntenticLine(line);
            if (parsed !== undefined) {
                yield parsed;
            }
        }
        const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? 0)));
        const outcome = { args: run.args, pid: child.pid, code, durationMs: Date.now() - startedAt };
        if (killedBy !== undefined) {
            throw new Error(`intentic ${run.args.join(" ")} was terminated: ${killedBy}`);
        }
        if (code !== 0) {
            logger?.warn({ ...outcome, stderr: stderr.trim().slice(0, 500) }, "intentic run failed");
            throw new Error(`intentic ${run.args.join(" ")} exited ${code}: ${stderr.trim()}`);
        }
        logger?.info(outcome, "intentic run completed");
    } finally {
        clearTimeout(watchdog);
        unwatchAbort();
        // Torn down mid-stream (dropped connection, consumer stopped iterating) with the child still alive: reap it.
        if (child.exitCode === null && child.signalCode === null) {
            kill("the stream consumer went away");
        }
    }
}
