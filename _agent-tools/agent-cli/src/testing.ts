// The in-process CLI runner these tools' end-to-end suites drive.
import { type Application, type CommandContext, run, type StricliProcess } from "@stricli/core";

export interface CliOutcome {
    readonly out: string;
    readonly err: string;
    /** Clamped the way the shell clamps it, so a suite reads the code a shell would: 0 content, 1 none, 2 else. */
    readonly exitCode: number;
}

const text = (chunk: string | Uint8Array): string => (typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());

/**
 * Runs the app through the same `run` seam `cli.ts` calls — no build artifact, no child process. It stands in for
 * THE process, not for the command's context: a command reaches stdout both through `this.process` and directly,
 * and a harness that captured only the context would read a message written the other way as silence. The exit
 * code is the one exception, since bun's process.exitCode cannot be cleared once written; see below.
 */
export const captureCli = async (app: Application<CommandContext>, args: readonly string[]): Promise<CliOutcome> => {
    let out = "";
    let err = "";
    const streams = { stdout: process.stdout.write, stderr: process.stderr.write };
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        out += text(chunk);
        return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        err += text(chunk);
        return true;
    }) as typeof process.stderr.write;
    // The run gets its own exitCode slot: bun keeps the first number ever written to process.exitCode, so a shared
    // global would carry one command's code into every later outcome.
    const previous = process.exitCode;
    const stand: StricliProcess = { stdout: process.stdout, stderr: process.stderr, env: process.env };
    try {
        await run(app, args, { process: stand });
        // A command that writes the global directly still counts, and wins: that is what the real binary exits with.
        const written = process.exitCode === previous ? stand.exitCode : process.exitCode;
        const code = typeof written === "number" ? written : 0;
        return { out, err, exitCode: code !== 0 && code !== 1 ? 2 : code };
    } finally {
        process.stdout.write = streams.stdout;
        process.stderr.write = streams.stderr;
        // An unset code and 0 are the same exit status, and 0 is the only "unset" bun can be put back to.
        process.exitCode = typeof previous === "number" ? previous : 0;
    }
};
