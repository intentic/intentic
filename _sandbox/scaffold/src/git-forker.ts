import { execFile } from "node:child_process";

// Child half of the resident forker (exec.ts has the rationale): execs what the parent asks and sends back the result.
// Nothing else may be added; every git the daemon runs forks from this address space, so it must stay minimal.

export interface ForkRequest {
    readonly id: number;
    readonly command: string;
    readonly args: readonly string[];
    readonly maxBuffer: number;
    // Whole child environment when set (e.g. GIT_INDEX_FILE); absent inherits this process's own at fork time.
    readonly env?: Readonly<Record<string, string | undefined>>;
}

// `failure` reduces execFile's error to `message` and `code`; stdout/stderr ride outside since execFile always reports
// them.
export interface ForkResponse {
    readonly id: number;
    readonly stdout: string;
    readonly stderr: string;
    // Timed here, not by the parent; the gap to the parent's clock is its own event-loop stall, not git's time.
    readonly execMs: number;
    readonly failure?: { readonly message: string; readonly code?: number | string };
}

const send = process.send?.bind(process);
if (send === undefined) {
    throw new Error("git forker started without an IPC channel");
}

process.on("message", (request: ForkRequest) => {
    const from = process.hrtime.bigint();
    execFile(
        request.command,
        [...request.args],
        { maxBuffer: request.maxBuffer, ...(request.env !== undefined ? { env: request.env } : {}) },
        (error, stdout, stderr) => {
            const response: ForkResponse = {
                id: request.id,
                stdout,
                stderr,
                execMs: Number(process.hrtime.bigint() - from) / 1e6,
                // A null code (signal-killed) carries nothing to branch on; omitted rather than passed through.
                ...(error === null
                    ? {}
                    : {
                          failure: {
                              message: error.message,
                              ...(error.code !== undefined && error.code !== null ? { code: error.code } : {}),
                          },
                      }),
            };
            send(response);
        },
    );
});

// Exit rather than linger as an orphan holding a dead pipe once the parent is gone.
process.on("disconnect", () => process.exit(0));
