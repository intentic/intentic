import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../env.config.js";
import type { Sink } from "./output.js";

// Retention is per command: frequent reads must not evict the rare plan/apply/resolve logs a postmortem needs.
const KEEP_RUNS_PER_COMMAND = 10;

// Failure a run died with, so the log tells a crash from a hang apart (stricli's stderr bypasses the tee).
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
            // Prune within this command's logs only (the filename prefix is the command name).
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
