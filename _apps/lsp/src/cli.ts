#!/usr/bin/env node
import { resolve } from "node:path";
import { diagnose } from "./diag.js";
import { findTsconfig, openProject } from "./project.js";
import { rename } from "./rename.js";

// lsp — TypeScript rename + diagnostics for the agent, over the TS language service. Two verbs:
//   lsp rename <file> <symbol> <newName>   rename a declared symbol across its TS project (updates every usage)
//   lsp diag <file...>                     print syntactic + semantic diagnostics for the given files
// Scope is the invoked file's own tsconfig project (see the skill). Exit 0 on success, 1 on a usage/arg error, 2
// on an internal failure.

const USAGE = "usage:\n  lsp rename <file> <symbol> <newName>\n  lsp diag <file...>";

const runRename = (args: readonly string[]): number => {
    const [file, symbol, newName] = args;
    if (file === undefined || symbol === undefined || newName === undefined) {
        process.stderr.write(`rename needs <file> <symbol> <newName>\n${USAGE}\n`);
        return 1;
    }
    const path = resolve(file);
    const result = rename(openProject(findTsconfig(path), path), path, symbol, newName);
    process.stdout.write(
        `renamed "${symbol}" → "${newName}": ${result.edits} occurrence(s) across ${result.changedFiles.length} file(s)\n${result.changedFiles
            .map((f) => `  ${f}`)
            .join("\n")}\n`,
    );
    return 0;
};

const runDiag = (args: readonly string[]): number => {
    const [first] = args;
    if (first === undefined) {
        process.stderr.write(`diag needs at least one <file>\n${USAGE}\n`);
        return 1;
    }
    const paths = args.map((arg) => resolve(arg));
    const diagnostics = diagnose(openProject(findTsconfig(resolve(first)), resolve(first)), paths);
    if (diagnostics.length === 0) {
        process.stdout.write("no diagnostics\n");
        return 0;
    }
    process.stdout.write(`${diagnostics.map((d) => `${d.file}:${d.line}:${d.column}: ${d.category} TS${d.code}: ${d.message}`).join("\n")}\n`);
    return 0;
};

const main = (argv: readonly string[]): number => {
    const [verb, ...rest] = argv;
    if (verb === "rename") {
        return runRename(rest);
    }
    if (verb === "diag") {
        return runDiag(rest);
    }
    process.stderr.write(`${verb === undefined ? "" : `unknown command: ${verb}\n`}${USAGE}\n`);
    return 1;
};

try {
    process.exitCode = main(process.argv.slice(2));
} catch (error) {
    process.stderr.write(`lsp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
}
