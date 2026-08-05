#!/usr/bin/env node
import { resolve } from "node:path";
import { diagnoseVia } from "./client.js";
import { runDaemon } from "./daemon.js";
import { diagnose, type Diagnostic } from "./diag.js";
import { findTsconfig, openProject, unusableReason } from "./project.js";
import { rename } from "./rename.js";

// lsp — TypeScript rename + diagnostics for the agent, over the TS language service. Three verbs:
//   lsp rename <file> <symbol> <newName>   rename a declared symbol across its TS project (updates every usage)
//   lsp diag <file...>                     print syntactic + semantic diagnostics for the given files
//   lsp daemon <root>                      serve the resident language service for <root> (started on demand)
// Scope is the invoked file's own tsconfig project (see the skill). Exit 0 on success, 1 on a usage/arg error, 2
// on an internal failure — including a project whose config cannot be loaded well enough to answer, because a
// wrong answer printed confidently is the one outcome this tool must never produce.
//
// `diag` goes through the resident daemon, which keeps the program warm between calls — a cold build of a
// monorepo package's LanguageService is ~1.7s and dwarfs the check itself. It falls back to building one here
// when no daemon can be reached, and ALSO when the daemon refuses: the daemon may stand in a mount namespace
// where this tree's node_modules are invisible, while this process stands where they are, so its own cold build
// can be the answerable one.

const USAGE = "usage:\n  lsp rename <file> <symbol> <newName>\n  lsp diag <file...>\n  lsp daemon <root>";

const runRename = (args: readonly string[]): number => {
    const [file, symbol, newName] = args;
    if (file === undefined || symbol === undefined || newName === undefined) {
        process.stderr.write(`rename needs <file> <symbol> <newName>\n${USAGE}\n`);
        return 1;
    }
    const path = resolve(file);
    const project = openProject(findTsconfig(path), path);
    // A rename on a half-loaded program is worse than a refused one: module resolution is how the usages are
    // FOUND, so a blind program quietly renames a subset and leaves the rest referring to the old name.
    const reason = unusableReason(project);
    if (reason !== undefined) {
        process.stderr.write(`rename unavailable — the project cannot be loaded well enough to find every usage: ${reason}\n`);
        return 2;
    }
    const result = rename(project, path, symbol, newName);
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
    // The files just came off the caller's disk edit as far as we know, so tell the daemon to re-read them
    // rather than trust whatever snapshot it is holding.
    const viaDaemon = await diagnoseVia(process.cwd(), { files: paths, touched: paths });
    if (viaDaemon !== undefined && viaDaemon.unavailable.length === 0) {
        return printDiagnostics(viaDaemon.diagnostics);
    }
    // No daemon, or a daemon that refused. Build the program in THIS process — its view of the tree is the
    // caller's own, which is the one place the answer can still be had — and refuse honestly if it is blind too.
    const project = openProject(findTsconfig(paths[0]!), paths[0]!);
    const reason = unusableReason(project);
    if (reason !== undefined) {
        process.stderr.write(`diagnostics unavailable — the project cannot be loaded well enough to answer: ${reason}\n`);
        return 2;
    }
    return printDiagnostics(diagnose(project, paths));
};

const main = async (argv: readonly string[]): Promise<number> => {
    const [verb, ...rest] = argv;
    if (verb === "rename") {
        return runRename(rest);
    }
    if (verb === "diag") {
        return await runDiag(rest);
    }
    if (verb === "daemon") {
        const [root] = rest;
        if (root === undefined) {
            process.stderr.write(`daemon needs <root>\n${USAGE}\n`);
            return 1;
        }
        await runDaemon(resolve(root));
        // The daemon holds the event loop open until it goes idle; returning here does not end the process.
        return 0;
    }
    process.stderr.write(`${verb === undefined ? "" : `unknown command: ${verb}\n`}${USAGE}\n`);
    return 1;
};

try {
    process.exitCode = await main(process.argv.slice(2));
} catch (error) {
    process.stderr.write(`lsp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
}
