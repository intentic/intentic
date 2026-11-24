import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { buildImportGraph, type ImportGraph, importersAtAnyDepth, projectImportersOf } from "./import-graph.js";
import { type Diagnostic, parseCompilerOutput } from "./report.js";
import { loadVueProject, typescriptOf, type VuePackage, type VueProject } from "./vue-project.js";

// A changed-files typecheck for a Vue package: the package's own `vue-tsc` over the files a change touches and the files
// that import them directly, instead of all of them. Measured 2026-10-26 on `_editor/web`: the full check takes 418-571 s
// and 6.8 GB, and about a dozen conversations each running it on one 21 GB sandbox is what queued every heavy command
// behind them. The scoped run is the same compiler under the same config, so what it says about the files it checked is
// what the full run would say; what it cannot see is a break two imports away, which is why a file many others reach
// (or a declaration, a tsconfig, a manifest) is sent to the full check instead.

// A change to a file this many project files import, at any depth, can break a file no direct importer is: the full check
// answers for it. Measured on `_editor/web` (2,977 files, aliases resolved): the median file has 36 such importers and
// the p90 91; 291 have more than 100, 231 more than 300, 223 more than 500, so the line sits in the gap where the core
// modules (stores, the contract's clients, composables most views use) begin, sending 8% of the files to the full check.
export const FALLBACK_IMPORTERS = 300;

// The name the heavy-command table knows a scoped check by (heavy-rules.cjs `vue-typecheck-changed`): its own lane, priced
// as `scoped-typecheck`.
export const CHANGED_TSCONFIG = "tsconfig.lsp-changed";

// Where a run's tsconfig, its build info and the import graph's cache live: inside the package, so `extends`, the type
// roots and node_modules resolve from where the package's own config does, and in `.cache`, which git ignores.
export const cacheDirOf = (pkg: VuePackage): string => join(pkg.dir, ".cache", "lsp-changed");

// Long enough for a queued wait (the table's 900 s for a slot and 120 s for memory) and the run itself.
const RUN_TIMEOUT_MS = 30 * 60_000;
// The heap the scoped run may take: the full check's script gives its 8 GiB; the widest scoped run measured
// (AgentsView.vue, about 1,800 files loaded) peaked at 3.9 GiB resident, and the gate prices one at 4 GiB.
const HEAP_MB = 6144;

export type VuePlan =
    | {
          readonly kind: "scoped";
          // The changed project files and the project files that import them directly (through a library's barrel for a
          // changed file outside the project).
          readonly targets: readonly string[];
          readonly changed: readonly string[];
          readonly importers: number;
          // Changed files the package's typecheck does not compile (a vite config, a script), which nothing here checks.
          readonly unchecked: readonly string[];
      }
    | { readonly kind: "full"; readonly reason: string }
    | { readonly kind: "none"; readonly unchecked: readonly string[] };

const FULL_ONLY = /(^|\/)(package\.json|tsconfig[^/]*\.json)$|\.d\.[cm]?ts$/u;

/** What a check of `changed` in this package needs: the targets of a scoped run, the full check (and why), or nothing. */
export const planVueCheck = (project: VueProject, graph: ImportGraph, changed: readonly string[], threshold = FALLBACK_IMPORTERS): VuePlan => {
    const inProject = new Set(project.files);
    const rel = (file: string): string => relative(project.pkg.dir, file);
    for (const file of changed) {
        if (FULL_ONLY.test(file)) {
            return { kind: "full", reason: `${rel(file)} is a ${basename(file).endsWith("package.json") ? "manifest" : file.endsWith(".json") ? "tsconfig" : "declaration file"}, which every file of the package may read` };
        }
        // A file of another package the graph never reached is imported through that package's own name (its `exports`),
        // which the graph does not follow: no importer it can name is no evidence of none.
        if (!file.startsWith(`${project.pkg.dir}/`) && !graph.imports.has(file)) {
            return { kind: "full", reason: `${rel(file)} is reached through a package import this check does not trace` };
        }
        const reach = importersAtAnyDepth(graph, file, threshold);
        if (reach > threshold) {
            return { kind: "full", reason: `${rel(file)} is imported by more than ${String(threshold)} of the package's files at some depth, past what its direct importers can vouch for` };
        }
    }
    const own = changed.filter((file) => inProject.has(file));
    const importers = new Set(changed.flatMap((file) => [...projectImportersOf(graph, file, inProject)]));
    const targets = [...new Set([...own, ...importers])].toSorted();
    const unchecked = changed.filter((file) => !inProject.has(file) && !graph.imports.has(file));
    if (targets.length === 0) {
        return { kind: "none", unchecked };
    }
    return { kind: "scoped", targets, changed: own, importers: targets.length - own.length, unchecked };
};

export interface VueCheckResult {
    // Diagnostics in the targets: the change's.
    readonly diagnostics: readonly Diagnostic[];
    // Errors the run printed for files it loaded beyond the targets, which the change did not ask about.
    readonly outside: number;
    readonly ms: number;
}

export type VueRun = VueCheckResult | { readonly failure: string };

export interface RunOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
}

const headOf = (text: string): string => text.trim().split("\n").slice(0, 5).join("\n");

// The tsconfig a scoped run reads: the package's own, with only the targets and the ambient declarations as its files.
// A `.vue` file goes in `include`, as its literal path: TypeScript refuses an extension it does not know in `files`, and
// only matches `include` patterns against the ones vue-tsc adds. Incremental, into a build info of this run's own that
// replaces the shared one when it ends: a later run over overlapping files reuses what this one learned, and two at once
// never write one file.
export const scopedTsconfig = (project: VueProject, targets: readonly string[], buildInfo: string) => {
    const all = [...new Set([...targets, ...project.ambient])];
    return {
        extends: project.pkg.tsconfig,
        compilerOptions: { noEmit: true, incremental: true, composite: false, tsBuildInfoFile: buildInfo },
        files: all.filter((file) => !file.endsWith(".vue")),
        include: all.filter((file) => file.endsWith(".vue")),
    };
};

interface Ran {
    readonly output: string;
    readonly stderr: string;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly ms: number;
    readonly timedOut: boolean;
}

// Node, never bun: vue-tsc patches TypeScript's own compiler as node loads it, and under bun every `.vue` import fails to
// resolve (measured: 145 false errors on one view). The CLI runs under node; its tests and a source run may not.
const NODE = process.versions["bun"] === undefined ? process.execPath : "node";

// Runs as node runs a package's bin, so the heavy-command hook names it `vue-tsc` and its `-p` names the scoped config.
const spawnVueTsc = (project: VueProject, config: string, options: RunOptions): Promise<Ran | { readonly failure: string }> =>
    new Promise((settle) => {
        const started = Date.now();
        const child = spawn(NODE, [`--max-old-space-size=${String(HEAP_MB)}`, project.pkg.vueTsc, "--noEmit", "--pretty", "false", "-p", config], {
            cwd: project.pkg.dir,
            env: options.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            output += String(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += String(chunk);
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, options.timeoutMs ?? RUN_TIMEOUT_MS);
        child.on("error", (error) => {
            clearTimeout(timer);
            settle({ failure: error.message });
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            settle({ output, stderr, code, signal, ms: Date.now() - started, timedOut });
        });
    });

/** What one run said about `targets`, or why it said nothing that can be trusted. */
export const judgeRun = (ran: Ran, project: VueProject, config: string, targets: readonly string[]): VueRun => {
    if (ran.signal !== null) {
        return { failure: ran.timedOut ? `vue-tsc did not finish within ${String(Math.round(ran.ms / 1000))}s` : `vue-tsc was killed by ${ran.signal}` };
    }
    const all = parseCompilerOutput(ran.output, project.pkg.dir).filter((d) => d.category !== "suggestion");
    const errors = all.filter((d) => d.category === "error");
    const said = headOf(ran.stderr) || headOf(ran.output);
    // tsc's own verdicts are 0 (clean) and 1 or 2 (errors, emitted or not); anything else is a crash.
    if (ran.code !== 0 && ran.code !== 1 && ran.code !== 2) {
        return { failure: `vue-tsc exited with code ${String(ran.code)}${said === "" ? "" : `: ${said}`}` };
    }
    const broken = errors.find((d) => d.file === "" || resolve(d.file) === config);
    if (broken !== undefined) {
        return { failure: `the scoped tsconfig did not load: ${broken.message}` };
    }
    if (ran.code !== 0 && errors.length === 0) {
        return { failure: `vue-tsc exited with code ${String(ran.code)} and no error this reader parses${said === "" ? "" : `: ${said}`}` };
    }
    const asked = new Set(targets);
    return {
        diagnostics: all.filter((d) => asked.has(resolve(d.file))),
        outside: errors.filter((d) => !asked.has(resolve(d.file))).length,
        ms: ran.ms,
    };
};

/** Runs the package's `vue-tsc` over `targets`; the tsconfig it writes is removed whatever happens. */
export const runVueCheck = async (project: VueProject, targets: readonly string[], options: RunOptions = {}): Promise<VueRun> => {
    const dir = cacheDirOf(project.pkg);
    const id = String(process.pid);
    const config = join(dir, `${CHANGED_TSCONFIG}.${id}.json`);
    const shared = join(dir, "tsbuildinfo");
    const own = join(dir, `tsbuildinfo.${id}`);
    const cleanup = (): void => {
        rmSync(config, { force: true });
        rmSync(own, { force: true });
    };
    process.once("exit", cleanup);
    try {
        mkdirSync(dir, { recursive: true });
        if (existsSync(shared)) {
            copyFileSync(shared, own);
        }
        writeFileSync(config, JSON.stringify(scopedTsconfig(project, targets, own), undefined, 4));
        const ran = await spawnVueTsc(project, config, options);
        if ("failure" in ran) {
            return ran;
        }
        const judged = judgeRun(ran, project, config, targets);
        if (!("failure" in judged) && existsSync(own)) {
            renameSync(own, shared);
        }
        return judged;
    } catch (error) {
        return { failure: `the scoped check could not run in ${dir}: ${errorMessage(error)}` };
    } finally {
        cleanup();
        process.removeListener("exit", cleanup);
    }
};

export interface PackageCheck {
    readonly pkg: VuePackage;
    readonly project: VueProject;
    readonly graph: ImportGraph;
}

/** The package's project and import graph, read once per ask; throws with what failed. */
export const prepareVueCheck = (pkg: VuePackage): PackageCheck => {
    const project = loadVueProject(pkg);
    const ts = typescriptOf(pkg);
    const graph = buildImportGraph({
        files: project.files,
        paths: project.paths,
        pathsBase: project.pathsBase,
        specifiersOf: (text) => ts.preProcessFile(text, true, true).importedFiles.map((imported) => imported.fileName),
        cacheFile: join(cacheDirOf(pkg), "imports.json"),
    });
    return { pkg, project, graph };
};

/** The full check a fallback names. */
export const fullCommandOf = (pkg: VuePackage): string => `pnpm --filter ${pkg.name} typecheck`;
