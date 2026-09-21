// The process contract an agent-facing CLI keeps, for the three that keep the same one (iq, fileq, webq).
// The reader is an agent, not a terminal: it pipes into `head`, it redirects stderr away, and it cannot tell a
// crash from a tool that found nothing — so every rule below exists to stop silence from reading as zero results.
import type { Application, CommandContext, StricliProcess } from "@stricli/core";

export interface LoadedCli {
    readonly app: Application<CommandContext>;
    /**
     * Absorbs argv dialects before stricli sees them; each returned line is printed as `<name>: <line>`. It
     * arrives with the app because it comes out of the same dynamically loaded graph, not from the entry file.
     */
    readonly prepareArgv?: (raw: readonly string[]) => { readonly argv: string[]; readonly lines: readonly string[] };
}

export interface AgentCliOptions {
    /** The binary's name: what the reader typed, and the prefix on every line this file writes. */
    readonly name: string;
    /** What an empty answer from this tool would be mistaken for — "result", "document", "page". */
    readonly noun: string;
    /**
     * Loads the app. A thunk, never a static import: everything under it (an engine, a native module, a driver)
     * must fail inside the catch below, where the fault can be reported, instead of before any handler runs.
     */
    readonly load: () => Promise<LoadedCli>;
    /** Rewrites what stricli was about to print; `undefined` keeps the text as it is. */
    readonly rewriteStderr?: (text: string) => string | undefined;
}

// Piping into `head` closes stdout mid-write; EPIPE is a clean stop, not a crash (grep convention).
const exitOnBrokenPipe = (): void => {
    process.stdout.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE") {
            process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
        }
        throw error;
    });
};

// Errors go to STDOUT: `<tool> … 2>/dev/null` is an agent reflex, and it would turn a failure into something
// indistinguishable from an empty answer. The exit code still says 2, so a script can tell them apart.
const errorsToStdout = (rewrite: ((text: string) => string | undefined) | undefined): void => {
    const emit = process.stdout.write.bind(process.stdout) as (value: string | Uint8Array, ...args: unknown[]) => boolean;
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        if (rewrite === undefined) {
            return emit(chunk, ...rest);
        }
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
        return emit(rewrite(text) ?? chunk, ...rest);
    }) as typeof process.stderr.write;
};

// A module graph that will not load is an INSTALL fault, and saying so is the point: the same silence otherwise
// reads as a search that found nothing, and the agent moves on to a worse tool believing the answer was no.
const startFault = (name: string, noun: string, error: unknown): string => {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return (
        `${name}: cannot start, ${detail}\n` +
        `${name}: this is a broken install, NOT an empty ${noun}. Do not read it as zero hits or fall back to ` +
        `another tool silently. Reinstall ${name} (or rebuild its workspace deps) and report it.\n`
    );
};

// Grep convention: 0 hits, 1 none, 2 anything else; clamps stricli's own routing codes into the contract.
const clampExitCode = (): void => {
    if (process.exitCode !== undefined && process.exitCode !== 0 && process.exitCode !== 1) {
        process.exitCode = 2;
    }
};

/**
 * Runs the app under the shared contract: EPIPE is a clean stop, errors land on stdout, a broken module graph
 * reports itself, and the exit code is 0 content / 1 none / 2 anything else.
 */
export const runAgentCli = async (options: AgentCliOptions): Promise<void> => {
    exitOnBrokenPipe();
    errorsToStdout(options.rewriteStderr);
    const raw = process.argv.slice(2);

    let cli: { run: typeof import("@stricli/core").run; loaded: LoadedCli };
    try {
        const [core, loaded] = await Promise.all([import("@stricli/core"), options.load()]);
        cli = { run: core.run, loaded };
    } catch (error) {
        process.stdout.write(startFault(options.name, options.noun, error));
        process.exit(2);
    }

    const prepared = cli.loaded.prepareArgv?.(raw) ?? { argv: raw, lines: [] };
    for (const line of prepared.lines) {
        // Also stdout: this is how an absorbed dialect reaches its reader past the usual `2>/dev/null`.
        process.stdout.write(`${options.name}: ${line}\n`);
    }
    await cli.run(cli.loaded.app, prepared.argv, { process: process as StricliProcess });
    clampExitCode();
};
