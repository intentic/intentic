import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../env.config.js";
import type { Sink } from "./output.js";

// Tee a command's rendered output to <intenticLogDir>/<command>-<timestamp>.log so every deploy-lifecycle run
// leaves a durable record, stdout is otherwise the only copy. Local-only, never committed. Token-printing
// commands (secrets, the tunnels) are deliberately NOT wired through this. Lazy open: a run that writes
// nothing leaves no file. Sync fs throughout, chunks are already-rendered strings, and the exit hook (the
// only place stricli's failure exit code is visible) must write synchronously.
//
// Retention is PER COMMAND, not global: high-frequency reads (the UI polls `deployments` several times a
// minute) must not evict the rare, important plan/apply/resolve logs, those are exactly the ones a
// postmortem needs.
const KEEP_RUNS_PER_COMMAND = 10;

// The failure a run died with, recorded by the CLI's exception formatter so the run log carries it. stricli
// renders errors on STDERR, which the stdout tee never sees, without this line a crashed run's log is
// indistinguishable from a hung run's (both just stop).
let runFailure: string | undefined;
export const recordRunFailure = (message: string): void => {
    runFailure = message;
};

export const withRunLog = (sink: Sink, command: string): Sink => {
    // `false` = the log dir is unwritable; stop retrying, stdout still has the run.
    let fd: number | false | undefined;
    const ensure = (): number | undefined => {
        if (fd !== undefined) {
            return fd === false ? undefined : fd;
        }
        try {
            const dir = loadConfig().intenticLogDir;
            mkdirSync(dir, { recursive: true });
            // Prune within THIS command's logs only (the filename prefix is the command name).
            const runs = readdirSync(dir)
                .filter((name) => name.startsWith(`${command}-`) && name.endsWith(".log"))
                .flatMap((name) => {
                    try {
                        return [{ name, mtimeMs: statSync(join(dir, name)).mtimeMs }];
                    } catch {
                        return [];
                    }
                })
                .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
            for (const run of runs.slice(KEEP_RUNS_PER_COMMAND - 1)) {
                rmSync(join(dir, run.name), { force: true });
            }
            const stamp = new Date().toISOString().replaceAll(":", "-");
            const opened = openSync(join(dir, `${command}-${stamp}.log`), "a");
            fd = opened;
            process.on("exit", (code) => {
                try {
                    if (runFailure !== undefined) {
                        writeSync(opened, `# error: ${runFailure}\n`);
                    }
                    writeSync(opened, `# exit ${code}\n`);
                    closeSync(opened);
                } catch {
                    // Too late to report anything.
                }
            });
            return opened;
        } catch {
            fd = false;
            return undefined;
        }
    };
    return {
        write: (chunk) => {
            sink.write(chunk);
            const opened = ensure();
            if (opened === undefined) {
                return;
            }
            try {
                writeSync(opened, chunk);
            } catch {
                fd = false;
            }
        },
    };
};
