import { whenAborted } from "@intentic/base/async";
import { type DetachedKind, detachedStamp } from "../seams/workload-stamp.js";
import { spawnAs, type Workload } from "./workload-class.js";
import { killGroup, TERM_GRACE_MS } from "./process-group.js";

// Run commands in their caller's workload class and a detached process group, stamped with a deadline for the reaper.
// Deadline/abort/selected overflows end the whole group (SIGTERM then grace/SIGKILL), preventing descendants from holding output open.
// Return execution facts; callers interpret exit status. Do not globally set WORKSPACE_ROOT_EXCLUDE_ENV:
// only workspace-root scanner callers supply it, since refs/ inside a real repo is ordinary content.

// The shells a command line can be handed to. `platform` is what `child_process.exec` uses on the POSIX systems the
// daemon runs on.
export type CheckShell = "sh" | "bash" | "bash-login" | "platform";

/** The argv that runs one shell line in `shell`. */
export const shellArgv = (command: string, shell: CheckShell): readonly [string, ...string[]] => {
    switch (shell) {
        case "sh":
            return ["sh", "-c", command];
        case "bash":
            return ["bash", "-c", command];
        case "bash-login":
            return ["bash", "-lc", command];
        case "platform":
            return ["/bin/sh", "-c", command];
    }
};

export interface CheckSpec {
    readonly argv: readonly string[];
    // Unset runs where the daemon stands: an argv that enters a namespace sets its own directory.
    readonly cwd?: string;
    // The whole environment, defaulting to the daemon's; the detached stamp is laid over it.
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly workload: Workload;
    // What the reaper and the process scan call it.
    readonly kind: DetachedKind;
    // Bytes kept per stream. Past it the stream is still read, so a chatty command never blocks on a full pipe.
    readonly captureBytes: number;
    // Which end of an overflowing stream is kept; the head by default.
    readonly keep?: "head" | "tail";
    // Both streams into `stdout`, in the order they arrived, for a caller that shows them as one transcript.
    readonly interleave?: boolean;
    // Whether an overflowing stream ends the command, for a caller that reads overflow as a failure anyway.
    readonly killOnOverflow?: boolean;
    // Written to the command's stdin, which is closed after; without it the command reads end-of-file at once.
    readonly stdin?: string;
    readonly graceMs?: number;
}

export interface CheckOutcome {
    // Undefined when the command did not exit on its own: killed (`ended`), never started (`spawnError`), or by a signal.
    readonly exitCode: number | undefined;
    // The signal that ended it, whoever sent it.
    readonly exitSignal?: NodeJS.Signals | undefined;
    readonly stdout: string;
    readonly stderr: string;
    // Whether either stream ran past `captureBytes`.
    readonly truncated: boolean;
    // Why this module ended it, when it did.
    readonly ended?: "timeout" | "aborted" | "overflow" | undefined;
    // Why it could not start (ENOENT for a missing program, say).
    readonly spawnError?: string | undefined;
}

// One stream's capture: chunks kept until the cap, then either dropped (head) or rolled (tail).
class Capture {
    private chunks: Buffer[] = [];
    private size = 0;
    overflowed = false;

    constructor(
        private readonly cap: number,
        private readonly keep: "head" | "tail",
    ) {}

    // Answers whether this chunk took the stream past its cap for the first time.
    add(chunk: Buffer): boolean {
        const first = !this.overflowed && this.size + chunk.length > this.cap;
        this.overflowed ||= first;
        if (this.keep === "head") {
            const room = this.cap - this.size;
            if (room > 0) {
                const kept = chunk.length <= room ? chunk : chunk.subarray(0, room);
                this.chunks.push(kept);
                this.size += kept.length;
            }
            return first;
        }
        this.chunks.push(chunk);
        this.size += chunk.length;
        if (this.size > this.cap) {
            const joined = Buffer.concat(this.chunks);
            const kept = joined.subarray(joined.length - this.cap);
            this.chunks = [kept];
            this.size = kept.length;
        }
        return first;
    }

    text(): string {
        return Buffer.concat(this.chunks).toString("utf8");
    }
}

/** Runs one command to completion or its deadline; resolves on every road and never rejects. */
export const runCheck = (spec: CheckSpec): Promise<CheckOutcome> =>
    new Promise((resolve) => {
        const [program, ...args] = spec.argv;
        if (program === undefined) {
            resolve({ exitCode: undefined, stdout: "", stderr: "", truncated: false, spawnError: "no command" });
            return;
        }
        if (spec.signal?.aborted === true) {
            resolve({ exitCode: undefined, stdout: "", stderr: "", truncated: false, ended: "aborted" });
            return;
        }
        const keep = spec.keep ?? "head";
        const stdout = new Capture(spec.captureBytes, keep);
        const stderr = new Capture(spec.captureBytes, keep);
        let ended: CheckOutcome["ended"];
        let spawnError: string | undefined;
        const child = spawnAs(spec.workload, program, args, {
            cwd: spec.cwd,
            // Its deadline rides along, so the reaper ends it even when the daemon that set it is gone.
            env: { ...(spec.env ?? process.env), ...detachedStamp(spec.kind, Date.now() + spec.timeoutMs) },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const end = (why: NonNullable<CheckOutcome["ended"]>): void => {
            if (ended !== undefined) {
                return;
            }
            ended = why;
            killGroup(child, spec.graceMs ?? TERM_GRACE_MS, "close");
        };
        const deadline = setTimeout(() => end("timeout"), spec.timeoutMs);
        deadline.unref();
        const unwatchAbort = whenAborted(spec.signal, () => end("aborted"));
        const read = (capture: Capture) => (chunk: Buffer) => {
            if (capture.add(chunk) && spec.killOnOverflow === true) {
                end("overflow");
            }
        };
        child.stdout.on("data", read(stdout));
        child.stderr.on("data", read(spec.interleave === true ? stdout : stderr));
        // A command that exits before reading its input closes the pipe under the write; `close` tells the real story.
        child.stdin.on("error", () => undefined);
        child.stdin.end(spec.stdin ?? "");
        let settled = false;
        const settle = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(deadline);
            unwatchAbort();
            resolve({
                exitCode: ended === undefined && spawnError === undefined ? (code ?? undefined) : undefined,
                exitSignal: exitSignal ?? undefined,
                stdout: stdout.text(),
                stderr: stderr.text(),
                truncated: stdout.overflowed || stderr.overflowed,
                ended,
                spawnError,
            });
        };
        child.on("error", (error) => {
            spawnError = error.message;
            // One that never started has nothing left to close; one that did still closes, and that is awaited.
            if (child.pid === undefined) {
                settle(null, null);
            }
        });
        child.on("close", settle);
    });

/** Tail of what a command printed, stderr first, as the guards and stop checks show it. */
export const outputTail = (outcome: Pick<CheckOutcome, "stdout" | "stderr">, chars: number): string =>
    `${outcome.stderr}${outcome.stdout}`.trim().slice(-chars);
