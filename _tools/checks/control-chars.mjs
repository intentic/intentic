#!/usr/bin/env node
// No literal control characters (a NUL, etc.) in tracked text: invisible in an editor, but git, grep and every diff
// viewer read the file as binary. Enforced via the checks manifest (pre-push, CI preflight, turn-ending) and by the
// `bytes-edit` write rule, both reading @intentic/constants/control-bytes.
import { readFileSync, statSync } from "node:fs";
import { byteName, escapeFor, firstForbiddenByte, isBinaryPath } from "../constants/src/control-bytes.mjs";
import { trackedFiles } from "./lib/repo.mjs";

const tracked = trackedFiles();

const findings = [];
for (const path of tracked) {
    if (isBinaryPath(path)) {
        continue;
    }
    let bytes;
    try {
        if (!statSync(path).isFile()) {
            continue;
        }
        bytes = readFileSync(path);
    } catch {
        continue; // a submodule, a symlink to nowhere, a path removed since `ls-files` answered
    }
    const found = firstForbiddenByte(bytes);
    if (found !== undefined) {
        findings.push({ path, ...found });
    }
}

if (findings.length > 0) {
    for (const { path, line, byte } of findings) {
        console.error(`${path}:${line}  literal ${byteName(byte)}: write it as an escape (${escapeFor(byte)}) so the file stays text`);
    }
    console.error(`\n${findings.length} file(s) carry a literal control character. Git, grep and every diff viewer read those as binary.`);
    process.exit(1);
}

console.log(`${tracked.length} tracked files, no literal control characters`);
