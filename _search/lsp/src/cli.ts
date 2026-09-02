#!/usr/bin/env node
import { resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { checkProject, findTsconfig } from "./checker.js";
import { diagnose } from "./client.js";
import { rename } from "./rename.js";
import type { Diagnostic } from "./report.js";

// lsp. TypeScript rename + diagnostics for the agent, over the native TypeScript compiler. Two verbs:
//   lsp rename <file> <symbol> <newName>   rename a declared symbol across its TS project (updates every usage)
//   lsp diag <file...>                     print syntactic + semantic diagnostics for the given files
// Scope is the invoked file's own tsconfig project (see the skill). Exit 0 on success, 1 on a usage/arg error, 2
// on an internal failure, including a project whose config cannot be loaded well enough to answer, because a
// wrong answer printed confidently is the one outcome this tool must never produce.
//
// Every question is answered by a fresh run of the native compiler, which parses the project, answers, and
// exits, nothing stays resident. A cold whole-project check costs 0.1–2s, at or below what the old resident
// JS-compiler daemon answered in through its socket, and it holds no memory between questions.

const USAGE = "usage:\n  lsp rename <file> <symbol> <newName>\n  lsp diag <file...>";

const runRename = async (args: readonly string[]): Promise<number> => {
    const [file, symbol, newName] = args;
    if (file === undefined || symbol === undefined || newName === undefined) {
        process.stderr.write(`rename needs <file> <symbol> <newName>\n${USAGE}\n`);
        return 1;
    }
    const path = resolve(file);
    // A rename on a half-loaded program is worse than a refused one: module resolution is how the usages are
    // FOUND, so a blind program quietly renames a subset and leaves the rest referring to the old name. The
    // same run that would refuse a diag refuses the rename, before anything is touched.
    const report = await checkProject(findTsconfig(path), [path], undefined);
    const [unavailable] = report.unavailable;
    if (unavailable !== undefined) {
        process.stderr.write(`rename unavailable, the project cannot be loaded well enough to find every usage: ${unavailable.reason}\n`);
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

const runDiag = async (args: readonly string[]): Promise<number> => {
    const [first] = args;
    if (first === undefined) {
        process.stderr.write(`diag needs at least one <file>\n${USAGE}\n`);
        return 1;
    }
    const paths = args.map((arg) => resolve(arg));
    const report = await diagnose({ files: paths });
    if (report === undefined) {
        // No tsconfig above any of these files: check each on its own against the compiler's defaults, the way
        // a projectless script is checked.
        const alone = await Promise.all(paths.map((path) => checkProject(undefined, [path], undefined)));
        const [refused] = alone.flatMap((r) => r.unavailable);
        if (refused !== undefined) {
            process.stderr.write(`diagnostics unavailable: ${refused.reason}\n`);
            return 2;
        }
        return printDiagnostics(alone.flatMap((r) => r.diagnostics));
    }
    const [unavailable] = report.unavailable;
    if (unavailable !== undefined) {
        process.stderr.write(`diagnostics unavailable, the project cannot be loaded well enough to answer: ${unavailable.reason}\n`);
        return 2;
    }
    return printDiagnostics(report.diagnostics);
};

const main = async (argv: readonly string[]): Promise<number> => {
    const [verb, ...rest] = argv;
    if (verb === "rename") {
        return await runRename(rest);
    }
    if (verb === "diag") {
        return await runDiag(rest);
    }
    process.stderr.write(`${verb === undefined ? "" : `unknown command: ${verb}\n`}${USAGE}\n`);
    return 1;
};

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    process.stderr.write(`lsp: ${errorMessage(error)}\n`);
    process.exitCode = 2;
}
