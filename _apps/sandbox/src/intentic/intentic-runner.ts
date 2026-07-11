import { spawn } from "node:child_process";
import type { IntenticLine } from "@intentic/sandbox-contract";

// `IntenticLine` (one parsed line from `intentic … --output ndjson`: engine events, provider `log`, the
// terminal `result`) is the wire shape the daemon streams, so it lives in @intentic/sandbox-contract. It stays
// structurally decoupled from @intentic/engine: the sandbox runs a pinned intentic binary in a separate
// process, so it consumes the wire shape, not the engine types.

// Parse a single ndjson line. Blank lines yield undefined; a non-object or one without a string `kind` is
// not a valid event and yields undefined. Malformed JSON throws (it would be a real contract violation).
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

// Split a stream of arbitrary string chunks into newline-delimited lines, carrying a partial line across
// chunk boundaries and flushing any trailing remainder. Pure async transform — the unit-testable core of
// reading a subprocess's streamed stdout.
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
    // The intentic subcommand + flags, e.g. ["resolve", "--config", "intent/deploy.config.ts"]. The runner
    // forces INTENTIC_OUTPUT=ndjson, so the command streams structured lines regardless of caller flags.
    readonly args: readonly string[];
    readonly cwd: string;
}

// Ceiling on one streamed CLI run. resolve/plan finish in seconds-to-a-minute when healthy and every network
// operation below them is individually bounded now — a run still alive after this is wedged, not working.
const RUN_WATCHDOG_MS = 10 * 60_000;

// The slice of a pino logger the runner needs — structural, so tests pass a plain recorder.
export interface RunLogger {
    readonly info: (fields: object, message: string) => void;
    readonly warn: (fields: object, message: string) => void;
}

// Run the in-sandbox intentic CLI and stream its ndjson lines as they arrive (so the UI sees live
// resolve/plan progress). A non-zero exit propagates as an error once the stream ends, with captured stderr.
// The child is KILLED when the caller aborts (browser tab closed — an abandoned SSE must not leak a live
// `intentic plan` with its SSH connections), when the generator is torn down, or when the watchdog fires.
// Every run's lifecycle (spawn, kill + reason, exit + duration + stderr head) lands in the daemon log — a
// crashed or killed run must be attributable from daemon.log alone, not reconstructed from absence.
export async function* runIntentic(run: IntenticRun, signal?: AbortSignal, logger?: RunLogger): AsyncGenerator<IntenticLine> {
    const startedAt = Date.now();
    const child = spawn("intentic", [...run.args], { cwd: run.cwd, env: { ...process.env, INTENTIC_OUTPUT: "ndjson" } });
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
    signal?.addEventListener("abort", onAbort, { once: true });
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
        signal?.removeEventListener("abort", onAbort);
        // Generator torn down mid-stream (the oRPC connection dropped without an abort event, or the consumer
        // stopped iterating) with the child still alive — reap it.
        if (child.exitCode === null && child.signalCode === null) {
            kill("the stream consumer went away");
        }
    }
}
