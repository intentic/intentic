import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Env } from "./hook-io.js";

// What the hooks start and find around them: the plugin's own files, programs on PATH, and background work that must
// outlive the hook without holding it open.

// The plugin's install directory. Claude Code exports it to every hook; a bundle run by hand finds it from its own place
// in dist/.
export const pluginRoot = (env: Env = process.env): string =>
    env["CLAUDE_PLUGIN_ROOT"] ?? dirname(import.meta.dirname);

// Gone (never written, never built, deleted), as opposed to there and unreadable: only the first is an ordinary answer.
export const isMissing = (error: unknown): boolean => {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    return code === "ENOENT" || code === "ENOTDIR";
};

// A file the build wrote into the plugin, or undefined when it is missing (a dev checkout that was never built).
export const pluginFile = (parts: readonly string[], env: Env = process.env): string | undefined => {
    try {
        return readFileSync(join(pluginRoot(env), ...parts), "utf8");
    } catch (error) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
};

// Whether a program is on PATH, found without starting it: a hook pays for every process it spawns.
export const onPath = (name: string, env: Env = process.env): boolean => {
    const extensions = process.platform === "win32" ? (env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
    for (const dir of (env["PATH"] ?? "").split(delimiter)) {
        for (const extension of extensions) {
            try {
                accessSync(join(dir, `${name}${extension}`), constants.X_OK);
                return true;
            } catch {
                // allow(silent-catch): absent, unreadable or not executable all mean the same here: not a program this PATH entry can run.
            }
        }
    }
    return false;
};

// Starts a program that outlives the hook and returns at once. Its output goes to a file and never to the hook's own
// pipes: Claude Code waits on a hook for as long as anything holds its stdout open.
export const startDetached = (command: string, args: readonly string[], options: { readonly cwd: string; readonly log: string; readonly env?: Env }): void => {
    mkdirSync(dirname(options.log), { recursive: true });
    const out = openSync(options.log, "w");
    try {
        const child = spawn(command, args, { cwd: options.cwd, detached: true, stdio: ["ignore", out, out], env: { ...(options.env ?? process.env) } });
        child.on("error", () => undefined);
        child.unref();
    } finally {
        closeSync(out);
    }
};

// True, and the stamp moved to now, when the last run is older than `everyMs`; false when it is still fresh. Claimed
// before the work starts, so two sessions opening together start it once rather than twice.
// A stamp that cannot be written is never due: work nobody can remember doing would otherwise start on every call.
export const claimIfDue = (stamp: string, everyMs: number, now: number = Date.now()): boolean => {
    try {
        if (now - statSync(stamp).mtimeMs < everyMs) {
            return false;
        }
    } catch {
        // allow(silent-catch): a stamp that cannot be read counts as never written; writing it below is what decides.
    }
    try {
        mkdirSync(dirname(stamp), { recursive: true });
        writeFileSync(stamp, `${now}\n`);
        return true;
    } catch (error) {
        process.stderr.write(`intentic: ${stamp} cannot be written (${error instanceof Error ? error.message : String(error)}), so what it paces is skipped\n`);
        return false;
    }
};

// A project path as one file name, for the per-project files the plugin keeps.
export const projectSlug = (project: string): string => project.replace(/[^a-zA-Z0-9]/g, "-");
