import { execFile } from "node:child_process";

/* THE RESIDENT FORKER'S CHILD HALF, exec.ts holds the argument for why it exists. This process does exactly
 * one thing: exec what the parent asks for and send back what came out.
 *
 * Nothing may ever be added to it, and that is the whole design. Its only job is to STAY SMALL: every git the
 * daemon runs is forked from THIS address space instead of the daemon's, and fork() copies page tables in
 * proportion to the resident size of whoever forks. A module imported here to make this file tidier would be
 * paid back on every git call the workspace ever makes.
 */

export interface ForkRequest {
    readonly id: number;
    readonly command: string;
    readonly args: readonly string[];
    readonly maxBuffer: number;
    // The child's WHOLE environment when the caller needed one (GIT_INDEX_FILE above all); absent ⇒ inherit
    // this process's, which is the daemon's as of the fork. Shaped like NodeJS.ProcessEnv so it passes straight
    // through to execFile.
    readonly env?: Readonly<Record<string, string | undefined>>;
}

// `failure` is execFile's error, reduced to the two fields callers actually read on the far side: `message`
// (gitFailureReason's fallback when stderr is empty) and `code` (politeGit branches on ENOENT). stdout/stderr
// ride outside it because execFile reports both whether or not the command failed.
export interface ForkResponse {
    readonly id: number;
    readonly stdout: string;
    readonly stderr: string;
    /* HOW LONG GIT ITSELF RAN, timed HERE and not on the far side, which is the only place the number is true.
     *
     * The parent measures a git call as wall clock from its own call site, so whatever it reports includes the
     * IPC hop and, decisively, however long the parent's event loop was away before it got round to reading
     * this response. That is not a small correction: this daemon's loop stalls past a second in 11% of its
     * sampled windows and past ten in 3%, and a stalled loop backdates nothing, it simply adds itself to every
     * measurement in flight. Every `for-each-ref` in the perf log reading three and a half seconds is a two
     * millisecond command that was waiting for a garbage collection it had nothing to do with.
     *
     * This process is a forking stub with an idle loop, so the gap between these two clocks IS the parent's
     * own stall, reported rather than inferred. `git.run` minus this is what the daemon spends waiting for
     * itself, and it is the difference between fixing git and fixing the thing actually holding the loop. */
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
                // A `null` code (killed by a signal) carries nothing the far side can branch on, absent is the
                // honest spelling, and the message still says what happened.
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

// The parent going away leaves nothing to serve, exit rather than linger as an orphan holding a dead pipe.
process.on("disconnect", () => process.exit(0));
