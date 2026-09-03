#!/usr/bin/env node
/* NO CONTROL CHARACTERS IN TRACKED TEXT: the byte-level invariant that keeps this repo readable.
 *
 * A NUL typed straight into a string literal is invisible in an editor and decisive everywhere else: git, grep,
 * `file`, code review and every diff viewer sniff for one and call the whole file binary. It is an easy thing to
 * write on purpose: a separator that cannot occur in the data is a real technique, and it cost this repo five
 * files, one of which spent six days and eighteen commits with no reviewable diff before anyone noticed.
 *
 * It then cost seven more, because this script was only ever reachable through `pnpm check`, no hook, no CI
 * job, nothing automatic. Being right is not the same as being run. It is in the checks manifest now, which the
 * pre-push hook, CI's preflight job and the turn-ending check all read; and the same bytes are refused the
 * moment an agent writes them, by the `bytes-edit` rule's script, which reads the table this reads
 * (@intentic/constants/control-bytes). */
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
