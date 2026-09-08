import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { type Diagnostic, type DiagReport, parseCompilerOutput } from "./report.js";
import { tsgoExePath } from "./tsgo.js";

// One check is one run of the native compiler over one tsconfig project; nothing stays resident between checks.
// Refuses rather than reporting diagnostics from a half-loaded program; .vue imports go unchecked, not falsely broken.

// The nearest tsconfig.json above a file is its project. A test file (`*.test.ts`) uses the sibling tsconfig.test.json
// when present, since the build config excludes test files.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const findTsconfig = (fromPath: string): string | undefined => {
    const file = resolve(fromPath);
    for (let dir = dirname(file); ;) {
        const candidate = join(dir, "tsconfig.json");
        if (existsSync(candidate)) {
            const tests = join(dir, "tsconfig.test.json");
            return TEST_FILE.test(file) && existsSync(tests) ? tests : candidate;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
};

// Where the check runs when this process is not already there; an entered check reaches an anchored turn's own mount
// namespace.
export interface CheckPlacement {
    readonly enter: (command: string, args: readonly string[]) => { readonly command: string; readonly args: readonly string[] };
}

const RUN_TIMEOUT_MS = 30_000;

// TS codes for a module-shape error from an unresolved or shimmed .vue import.
const VUE_MODULE_SHAPE = new Set([2305, 2306, 2307, 2613, 2614]);
const namesVueModule = (message: string): boolean => /['"][^'"]*\.vue['"]/.test(message);

// TS codes for a program whose type foundations (a types entry, global types) failed to load, not code faults.
const UNLOADED_FOUNDATIONS = new Set([2318, 2468, 2688]);

// TS codes for a missing-name error; phantom, not real, when the types sit only in a parent node_modules/@types.
const MISSING_TYPE_DEFINITIONS = new Set([2580, 2582, 2584, 2591]);

const typesAbove = (fromDir: string): boolean => {
    for (let dir = resolve(fromDir); ;) {
        if (existsSync(join(dir, "node_modules", "@types"))) {
            return true;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return false;
        }
        dir = parent;
    }
};

interface RunResult {
    readonly output: string;
    readonly failure: string | undefined;
}

// Runs the compiler to completion at lowered priority, since a check must lose to the control plane under contention.
// `failure` is a process-level fault (could not spawn, did not finish), not a non-zero exit for found errors.
const runCompiler = (args: readonly string[], cwd: string, placement: CheckPlacement | undefined): Promise<RunResult> =>
    new Promise((settle) => {
        let exe: string;
        try {
            exe = tsgoExePath();
        } catch (error) {
            settle({ output: "", failure: errorMessage(error) });
            return;
        }
        // Paths are relative to the compiler's cwd; an entered run sets it via `env -C`.
        const direct = { command: exe, args, options: { cwd } };
        const entered = placement === undefined ? undefined : placement.enter("/usr/bin/env", ["-C", cwd, exe, ...args]);
        const { command, args: argv, options } = entered === undefined ? direct : { ...entered, options: {} };
        const child = spawn(command, [...argv], { ...options, stdio: ["ignore", "pipe", "pipe"] });
        if (child.pid !== undefined) {
            try {
                os.setPriority(child.pid, 10);
            } catch {
                // EPERM/ESRCH, the check just runs undemoted.
            }
        }
        let output = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            output += String(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += String(chunk);
        });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
        }, RUN_TIMEOUT_MS);
        child.on("error", (error) => {
            clearTimeout(timer);
            settle({ output, failure: error.message });
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (signal !== null) {
                settle({ output, failure: `the checker did not answer within ${RUN_TIMEOUT_MS / 1000}s` });
                return;
            }
            // Exit code 1 means errors were found; any other code with empty output is a fault, kept verbatim.
            settle({ output: output === "" && code !== 0 && code !== 1 ? stderr : output, failure: undefined });
        });
    });

const refusal = (files: readonly string[], reason: string): DiagReport => ({
    diagnostics: [],
    unavailable: files.map((file) => ({ file, reason })),
});

// Reason this run's diagnostics can't be trusted, or undefined when they can.
// Checked before relaying any diagnostic: a half-loaded program's diagnostics are confident, specific, and wrong.
const unusableReason = (diagnostics: readonly Diagnostic[], tsconfigPath: string | undefined, projectDir: string): string | undefined => {
    for (const d of diagnostics) {
        if (d.category !== "error") {
            continue;
        }
        // No location, or a location in the config file itself, means the config chain failed to load.
        if (d.file === "" || (tsconfigPath !== undefined && resolve(d.file) === resolve(tsconfigPath))) {
            return d.message;
        }
        if (UNLOADED_FOUNDATIONS.has(d.code)) {
            return d.message;
        }
        if (MISSING_TYPE_DEFINITIONS.has(d.code) && typesAbove(projectDir)) {
            return (
                "the checker could not load type definitions that sit in a parent node_modules/@types " +
                "(the native compiler does not auto-include those): run the package's own type-check for a verdict"
            );
        }
    }
    return undefined;
};

// Diagnostics for `files` from one compiler run over the whole project, filtered to those files.
// Cross-file breakage on `files` still surfaces, since the whole program was checked to answer.
export const checkProject = async (
    tsconfigPath: string | undefined,
    files: readonly string[],
    placement: CheckPlacement | undefined,
): Promise<DiagReport> => {
    const projectDir = dirname(tsconfigPath ?? files[0] ?? ".");
    const args = tsconfigPath === undefined ? ["--noEmit", "--pretty", "false", ...files] : ["--noEmit", "--pretty", "false", "-p", tsconfigPath];
    const { output, failure } = await runCompiler(args, projectDir, placement);
    if (failure !== undefined) {
        return refusal(files, failure);
    }
    const all = parseCompilerOutput(output, projectDir);
    const reason = unusableReason(all, tsconfigPath, projectDir);
    if (reason !== undefined) {
        return refusal(files, reason);
    }
    const asked = new Set(files.map((file) => resolve(file)));
    const diagnostics = all.filter(
        (d) => asked.has(resolve(d.file)) && !(VUE_MODULE_SHAPE.has(d.code) && namesVueModule(d.message)) && d.category !== "suggestion",
    );
    return { diagnostics, unavailable: [] };
};
