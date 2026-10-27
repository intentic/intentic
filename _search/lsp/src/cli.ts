#!/usr/bin/env node
import { resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { changedFiles } from "./changed.js";
import { checkProject, findTsconfig } from "./checker.js";
import { diagnose } from "./client.js";
import { rename } from "./rename.js";
import type { Diagnostic } from "./report.js";
import { diagnoseVueGroup, splitByVuePackage } from "./vue-diag.js";
import { vuePackageOf } from "./vue-project.js";

// lsp: TypeScript rename and diagnostics for the agent, over the native compiler; nothing stays resident.
//   lsp rename <file> <symbol> <newName> rename a declared symbol across its TS project
//   lsp diag <file...> print diagnostics for the given files
//   lsp diag --changed  the same for every file changed since the branch left main, untracked ones included
//   lsp diag --from <package dir> <file...>  files of other packages, checked through that Vue package's own files
//                       that import them (the end-of-turn check's dependents, _tools/scripts/verify/reach-typecheck.mjs)
// A file of a Vue package (one whose typecheck is vue-tsc) is checked by that package's own vue-tsc over the files the
// change touches and their direct importers (vue-diag.ts); every other file by the native compiler, over its project.
// The agent-CLI contract (@intentic/agent-cli's run.ts): everything, errors included, goes to stdout, because an agent
// drops stderr and would read a refusal as an empty answer. Exit 0 is an answer ("no diagnostics" included), 2 is
// anything else: a usage error, an unloadable project, an internal failure. There is no "found nothing" 1.

const USAGE =
    "usage:\n  lsp rename <file> <symbol> <newName>\n  lsp diag <file...>\n  lsp diag --changed [<file...>]\n  lsp diag --from <package dir> <file...>";

const say = (text: string): void => void process.stdout.write(text);

const runRename = async (args: readonly string[]): Promise<number> => {
    const [file, symbol, newName] = args;
    if (file === undefined || symbol === undefined || newName === undefined) {
        say(`lsp: rename needs <file> <symbol> <newName>\n${USAGE}\n`);
        return 2;
    }
    const path = resolve(file);
    // A rename on a half-loaded program could silently rename a subset of usages; refuse first, like diag.
    const report = await checkProject(findTsconfig(path), [path], undefined);
    const [unavailable] = report.unavailable;
    if (unavailable !== undefined) {
        say(`lsp: rename unavailable, the project cannot be loaded well enough to find every usage: ${unavailable.reason}\n`);
        return 2;
    }
    const result = await rename(path, symbol, newName);
    process.stdout.write(
        `renamed "${symbol}" → "${newName}": ${result.edits} occurrence(s) across ${result.changedFiles.length} file(s)\n${result.changedFiles
            .map((f) => `  ${f}`)
            .join("\n")}\n`,
    );
    return 0;
};

const printDiagnostics = (diagnostics: readonly Diagnostic[]): number => {
    if (diagnostics.length === 0) {
        process.stdout.write("no diagnostics\n");
        return 0;
    }
    process.stdout.write(`${diagnostics.map((d) => `${d.file}:${d.line}:${d.column}: ${d.category} TS${d.code}: ${d.message}`).join("\n")}\n`);
    return 0;
};

// The native compiler's answer for files outside any Vue package, as `lsp diag` has always given it.
const diagnosePlain = async (paths: readonly string[]): Promise<number> => {
    const report = await diagnose({ files: paths });
    if (report === undefined) {
        // No tsconfig above any of these files: check each alone against the compiler's defaults.
        const alone = await Promise.all(paths.map((path) => checkProject(undefined, [path], undefined)));
        const [refused] = alone.flatMap((r) => r.unavailable);
        if (refused !== undefined) {
            say(`lsp: diagnostics unavailable: ${refused.reason}\n`);
            return 2;
        }
        return printDiagnostics(alone.flatMap((r) => r.diagnostics));
    }
    const [unavailable] = report.unavailable;
    if (unavailable !== undefined) {
        say(`lsp: diagnostics unavailable, the project cannot be loaded well enough to answer: ${unavailable.reason}\n`);
        return 2;
    }
    return printDiagnostics(report.diagnostics);
};

// What `--changed` hands each kind of checker: code and the files that configure it, not documents or assets.
const CODE = /\.([cm]?[jt]sx?|vue)$/u;
const CONFIGURES = /(^|\/)(package\.json|tsconfig[^/]*\.json)$/u;

// `--from <dir>`: every file, wherever it lives, is checked as the Vue package at <dir> sees it.
const runFrom = async (dir: string | undefined, files: readonly string[]): Promise<number> => {
    const pkg = dir === undefined ? undefined : vuePackageOf(resolve(dir, "package.json"));
    if (pkg === undefined || files.length === 0) {
        say(`lsp: diag --from needs a Vue package's directory and at least one <file>\n${USAGE}\n`);
        return 2;
    }
    const report = await diagnoseVueGroup({ pkg, files: files.map((file) => resolve(file)) });
    say(`${report.lines.join("\n")}\n`);
    return report.refused ? 2 : 0;
};

const runDiag = async (args: readonly string[]): Promise<number> => {
    const from = args.indexOf("--from");
    if (from !== -1) {
        return await runFrom(args[from + 1], args.filter((_, index) => index !== from && index !== from + 1));
    }
    const changed = args.includes("--changed");
    const named = args.filter((arg) => arg !== "--changed").map((arg) => resolve(arg));
    if (!changed && named.length === 0) {
        say(`lsp: diag needs at least one <file>\n${USAGE}\n`);
        return 2;
    }
    let paths = named;
    if (changed) {
        const found = changedFiles(process.cwd());
        if ("failure" in found) {
            say(`lsp: diag --changed: ${found.failure}\n`);
            return 2;
        }
        const relevant = found.files.filter((file) => CODE.test(file) || CONFIGURES.test(file));
        say(`lsp: ${String(relevant.length)} changed file(s) to check since ${found.baseName}\n`);
        paths = [...new Set([...named, ...relevant])];
        if (paths.length === 0) {
            return 0;
        }
    }
    const { vue, rest } = splitByVuePackage(paths);
    let code = 0;
    // One package at a time: each is a compiler run the heavy-command queue meters, and the machine is shared.
    for (const group of vue) {
        const report = await diagnoseVueGroup(group);
        say(`${report.lines.join("\n")}\n`);
        code = Math.max(code, report.refused ? 2 : 0);
    }
    const plain = changed ? rest.filter((file) => CODE.test(file) && !file.endsWith(".vue")) : rest;
    if (plain.length > 0) {
        code = Math.max(code, await diagnosePlain(plain));
    }
    return code;
};

const main = async (argv: readonly string[]): Promise<number> => {
    const [verb, ...rest] = argv;
    if (verb === "rename") {
        return await runRename(rest);
    }
    if (verb === "diag") {
        return await runDiag(rest);
    }
    say(`${verb === undefined ? "" : `lsp: unknown command: ${verb}\n`}${USAGE}\n`);
    return 2;
};

// Piping into `head` closes stdout mid-write; that is a clean stop, not a crash.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
        process.exit(Number(process.exitCode ?? 0));
    }
    throw error;
});

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    say(`lsp: ${errorMessage(error)}\n`);
    process.exitCode = 2;
}
