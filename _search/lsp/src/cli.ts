#!/usr/bin/env node
import { resolve } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { checkProject, findTsconfig } from "./checker.js";
import { diagnose } from "./client.js";
import { rename } from "./rename.js";
import type { Diagnostic } from "./report.js";

// lsp: TypeScript rename and diagnostics for the agent, over the native compiler; nothing stays resident.
//   lsp rename <file> <symbol> <newName> rename a declared symbol across its TS project
//   lsp diag <file...> print diagnostics for the given files
// The agent-CLI contract (@intentic/agent-cli's run.ts): everything, errors included, goes to stdout, because an agent
// drops stderr and would read a refusal as an empty answer. Exit 0 is an answer ("no diagnostics" included), 2 is
// anything else: a usage error, an unloadable project, an internal failure. There is no "found nothing" 1.

const USAGE = "usage:\n  lsp rename <file> <symbol> <newName>\n  lsp diag <file...>";

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

const runDiag = async (args: readonly string[]): Promise<number> => {
    const [first] = args;
    if (first === undefined) {
        say(`lsp: diag needs at least one <file>\n${USAGE}\n`);
        return 2;
    }
    const paths = args.map((arg) => resolve(arg));
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
