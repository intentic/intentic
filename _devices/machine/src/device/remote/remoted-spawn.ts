import { spawn } from "node:child_process";
import { closeSync, openSync, renameSync, statSync } from "node:fs";
import { readTextIfExists } from "@intentic/base/fs";
import { lineSplitter } from "../tools/sandboxes.js";
import type { DetachRemoted, RemotedExit, SpawnRemoted } from "./remoted.js";

/* HOW intentic-remoted IS STARTED (remoted.ts decides which): as this agent's child, ending with it, or detached, to
   outlive it and be adopted over its control endpoint. */

// The real child: stdin a pipe this agent holds (`--parent-stdin` is remoted's word to leave when it closes), stdout and
// stderr read a line at a time, and no window on Windows.
export const spawnRemoted: SpawnRemoted = (binary, configPath, onStdout, onStderr) => {
    const proc = spawn(binary, ["run", "--config", configPath, "--parent-stdin"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out = lineSplitter(onStdout);
    const err = lineSplitter(onStderr);
    // A remoted that left first makes the pipe refuse what is still written to it; its exit says why.
    proc.stdin.on("error", () => undefined);
    proc.stdout.setEncoding("utf8").on("data", out.push);
    proc.stderr.setEncoding("utf8").on("data", err.push);
    let failed: string | undefined;
    const exited = new Promise<RemotedExit>((resolve) => {
        proc.on("error", (error) => {
            failed = `could not run (${error.message})`;
        });
        proc.on("close", (code, signal) => {
            out.end();
            err.end();
            resolve(failed === undefined ? { code, signal } : { code, signal, error: failed });
        });
    });
    return {
        pid: proc.pid,
        exited,
        leave: () => proc.stdin.end(),
        kill: () => void proc.kill(),
        lastLine: () => undefined,
    };
};

// remoted.log is rolled to remoted.log.1 past this, as a detached remoted starts.
const LOG_ROLL_BYTES = 1024 * 1024;

const openRemotedLog = (path: string): number => {
    try {
        if (statSync(path).size > LOG_ROLL_BYTES) {
            renameSync(path, `${path}.1`);
        }
    } catch {
        // allow(silent-catch): no log yet, or one another process holds open on Windows: it is appended to
    }
    return openSync(path, "a", 0o600);
};

// The real detached start: its own session (process group) on Unix and no window on Windows, so neither this agent's
// end nor its supervisor's takes it along; stdout dropped (its status comes over the endpoint), stderr to `logPath`.
export const detachRemoted =
    (logPath: string): DetachRemoted =>
    (binary, configPath, endpoint) => {
        const log = openRemotedLog(logPath);
        let proc;
        try {
            proc = spawn(binary, ["run", "--config", configPath, "--control", endpoint], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", log] });
        } finally {
            closeSync(log);
        }
        proc.unref();
        let failed: string | undefined;
        const exited = new Promise<RemotedExit>((resolve) => {
            proc.on("error", (error) => {
                failed = `could not run (${error.message})`;
            });
            proc.on("exit", (code, signal) => resolve(failed === undefined ? { code, signal } : { code, signal, error: failed }));
        });
        return {
            pid: proc.pid,
            exited,
            kill: () => void proc.kill("SIGKILL"),
            lastLine: async () =>
                ((await readTextIfExists(logPath)) ?? "")
                    .split(/\r?\n/)
                    .findLast((line) => line.trim() !== ""),
        };
    };
