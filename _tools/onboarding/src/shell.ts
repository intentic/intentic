import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";

/* HOW THIS TIER RUNS THE THINGS A USER RUNS — one fresh shell, shared by every provisioner.
 *
 * A FRESH TERMINAL, not this process's environment, and that distinction cost an afternoon.
 *
 * Compose interpolates `${CONNECT_TOKEN}` from the `.env` the claim wrote, but the SHELL's environment
 * outranks that file. This harness runs inside a sandbox that happens to export a `CONNECT_TOKEN` of its own,
 * so compose quietly started the box with somebody else's credential: the container came up perfectly, the
 * platform answered every announce with 404, and nothing anywhere said the word "token".
 *
 * A user pasting a command is in a fresh terminal, so that is what they get. The allowlist is what a shell
 * needs to find `curl` and reach Docker, and nothing else; a denylist would only ever be as good as the next
 * variable somebody adds to the compose file. The CLI lane inherits the same floor for the same reason —
 * `ic sandbox connect` reads CONNECT_TOKEN, SANDBOX_IMAGE and PLATFORM_URL off its own environment too.
 */

const run = promisify(execFile);

const PASS_THROUGH = [`PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `XDG_RUNTIME_DIR`];

export const freshShellEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...Object.fromEntries(PASS_THROUGH.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))),
    ...extra,
});

/** A command the wizard rendered, run in a folder, failing with what it printed. */
export const sh = async (command: string, cwd: string, what: string, timeoutMs = 300_000): Promise<string> => {
    try {
        const { stdout, stderr } = await run(`sh`, [`-c`, command], {
            cwd,
            env: freshShellEnv(),
            timeout: timeoutMs,
            maxBuffer: 32 * 1024 * 1024,
        });
        return `${stdout}${stderr}`;
    } catch (cause) {
        const message = errorMessage(cause);
        throw new Error(`${what} failed: ${message}`, { cause });
    }
};

export interface Completed {
    /** The exit status. -1 when the process was killed (a timeout) rather than exiting on its own. */
    readonly code: number;
    /** stdout and stderr as the terminal saw them, interleaved: this is read by a person diagnosing a run. */
    readonly output: string;
}

/* A tool run whose NON-ZERO EXIT IS AN ANSWER rather than a throw — which `sh` above cannot give, because a
 * failed exec rejects with a message and drops the output that explains it. The CLI lane needs both halves: a
 * setup can end non-zero for a reason that is this world's (no edge exists here to answer a public address)
 * and the only way to tell that apart from a real failure is to READ what the checklist printed. */
export const runTool = async (
    file: string,
    args: readonly string[],
    options: { readonly env: Record<string, string>; readonly timeoutMs: number },
): Promise<Completed> =>
    new Promise<Completed>((resolveRun, rejectRun) => {
        const child = spawn(file, [...args], { env: options.env, timeout: options.timeoutMs });
        let output = ``;
        child.stdout.on(`data`, (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on(`data`, (chunk: Buffer) => (output += chunk.toString()));
        child.on(`error`, rejectRun);
        child.on(`close`, (code) => resolveRun({ code: code ?? -1, output }));
    });
