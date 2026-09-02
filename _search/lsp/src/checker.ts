import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { type Diagnostic, type DiagReport, parseCompilerOutput } from "./report.js";
import { tsgoExePath } from "./tsgo.js";

/* One check = one run of the native compiler over one tsconfig project, exiting when it has answered.
 *
 * This used to be a resident JS-compiler daemon: ~1 GB of warm program per view of the tree, held for a
 * 15-minute idle window, times one per concurrent agent worktree, the single largest steady memory cost on the
 * machine, paid to make a per-edit check affordable. The native compiler inverts the economics: a cold
 * whole-project check costs 0.1–2s and gives every byte back when it exits, which is at or below what a warm
 * answer cost through the old daemon's socket. So nothing stays resident, and there is no daemon to leak, to
 * duplicate, or to swap out under memory pressure.
 *
 * What survives from the old engine is its epistemics, because they were never about the compiler:
 *
 *   - REFUSE RATHER THAN GUESS. A config chain that does not load, or a program whose type foundations
 *     (@types, global types) did not resolve, makes the compiler report phantom errors on healthy code,
 *     confident, specific, and wrong. Every such state comes back as `unavailable` with the reason, never as
 *     diagnostics. One refusal is native-era new: the native compiler does not auto-include @types from
 *     PARENT node_modules the way the JS one does, so a program that trips over missing node globals while an
 *     ancestor @types directory exists is refused, the caller's own toolchain would have loaded them.
 *   - .vue IMPORTS GO UNCHECKED, NOT FALSELY BROKEN. Resolving .vue modules is the Vue toolchain's job
 *     (vue-tsc); this checker drops the module-shape errors those imports produce, and keeps every other
 *     diagnostic in the file real. The old engine shimmed them to `any` at resolution time; filtering the
 *     errors of an unresolved import leaves the same `any` in the program and the same silence in the report. */

// The compiler answers about one project; callers ask about files. The nearest tsconfig.json above a file is
// its project, the same question ts.findConfigFile answers, asked without loading any compiler.
export const findTsconfig = (fromPath: string): string | undefined => {
    for (let dir = dirname(resolve(fromPath)); ;) {
        const candidate = join(dir, "tsconfig.json");
        if (existsSync(candidate)) {
            return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
};

// Where the check runs when that is not where this process stands: an anchored turn's dependencies exist only
// inside its mount namespace, so the compiler must be entered into it, asked in that namespace's own names.
export interface CheckPlacement {
    readonly enter: (command: string, args: readonly string[]) => { readonly command: string; readonly args: readonly string[] };
}

const RUN_TIMEOUT_MS = 30_000;

// Module-shape errors an unresolved or shimmed .vue import produces; dropped when the message names a .vue
// module, per the header. 2307 cannot-find-module, 2305/2306/2613/2614 no-such-export against the any-shim.
const VUE_MODULE_SHAPE = new Set([2305, 2306, 2307, 2613, 2614]);
const namesVueModule = (message: string): boolean => /['"][^'"]*\.vue['"]/.test(message);

// The errors that mean the program's FOUNDATIONS failed to load: a `types` entry with no type definition file
// behind it (2688), or the global types and values every file leans on (2318, 2468). They indict the
// environment the checker stands in, not the code.
const UNLOADED_FOUNDATIONS = new Set([2318, 2468, 2688]);

// "Cannot find name 'process'. Do you need to install type definitions?", real when the types are nowhere,
// phantom when they sit in a PARENT node_modules/@types the JS compiler would auto-include and the native one
// does not. `typesAbove` is how the two are told apart.
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

// Run the compiler to completion, demoted: a check is background tooling and must lose to the control plane
// under contention. `failure` is a process-level fault (could not spawn, did not finish), not a non-zero exit,
// which is how the compiler ordinarily reports that it found errors.
const runCompiler = (args: readonly string[], cwd: string, placement: CheckPlacement | undefined): Promise<RunResult> =>
    new Promise((settle) => {
        let exe: string;
        try {
            exe = tsgoExePath();
        } catch (error) {
            settle({ output: "", failure: errorMessage(error) });
            return;
        }
        /* The compiler prints paths relative to its working directory. A direct spawn sets that directory
         * itself; an entered one runs behind `env -C`, because the placement's argv wrapper owns the working
         * directory inside the namespace and this process cannot reach it any other way. */
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
            // The compiler exits 1 for "errors found", an answer. Anything else with no parseable output is a
            // fault worth carrying verbatim.
            settle({ output: output === "" && code !== 0 && code !== 1 ? stderr : output, failure: undefined });
        });
    });

const refusal = (files: readonly string[], reason: string): DiagReport => ({
    diagnostics: [],
    unavailable: files.map((file) => ({ file, reason })),
});

// Why this run's answers cannot be vouched for, or undefined when they can. Checked before any diagnostic is
// relayed: diagnostics from a half-loaded program are confident, specific and wrong, worse than silence.
const unusableReason = (diagnostics: readonly Diagnostic[], tsconfigPath: string | undefined, projectDir: string): string | undefined => {
    for (const d of diagnostics) {
        if (d.category !== "error") {
            continue;
        }
        // A fault located in the config file itself, or reported with no location at all, is the config chain
        // failing to load, the state the JS compiler recovered from by checking against decade-old defaults.
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

// Diagnostics for `files` within one project, computed by one compiler run over the whole project and filtered
// to the asked files, cross-file breakage still surfaces on the file being asked about, because the whole
// program was checked to answer.
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
