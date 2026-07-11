import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Vendor } from "../schema.js";

interface AgentRunOptions {
    readonly cwd: string;
    readonly prompt: string;
    readonly maxTurns: number;
    readonly timeoutMs: number;
    readonly model?: string;
    readonly env: NodeJS.ProcessEnv;
}

// Optional metrics stay absent when a vendor doesn't report them — the report renders "—", never fabricates.
export interface AgentRunResult {
    readonly answer: string;
    readonly turns?: number;
    readonly tokensIn?: number;
    readonly tokensOut?: number;
    readonly cacheReadTokens?: number;
    readonly costUsd?: number;
    readonly exitCode: number;
    // Full raw stdout — saved as the run transcript.
    readonly raw: string;
}

export interface AgentAdapter {
    readonly id: Vendor;
    // Omitted = let the vendor CLI use its configured default (recorded as "default" in run records).
    readonly defaultModel?: string;
    available(): boolean;
    run(options: AgentRunOptions): Promise<AgentRunResult>;
}

export const onPath = (binary: string): boolean =>
    (process.env["PATH"] ?? "").split(":").some((dir) => {
        if (dir === "") {
            return false;
        }
        try {
            accessSync(join(dir, binary), constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });

export interface ExecOutcome {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: number;
}

// Agent CLIs stream a lot of stdout and are killed hard on timeout; partial stdout is still parsed so a
// timed-out run yields whatever metrics it produced before dying.
export const execAgent = (
    binary: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<ExecOutcome> =>
    new Promise((resolvePromise) => {
        execFile(
            binary,
            args,
            { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) => {
                const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
                resolvePromise({ stdout, stderr, exitCode });
            },
        );
    });
