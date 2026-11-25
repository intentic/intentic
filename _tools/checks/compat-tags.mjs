#!/usr/bin/env node
// A fallback kept for an older far end is tagged `compat(<peer><<x.y.z>): <why>` (docs/architecture/conventions.md,
// "Version skew"), and this fails a tag whose version is at or below that peer's floor (the branch is dead: delete it),
// one naming a peer with no floor, and one that does not parse. So raising a floor lists every branch it retired.
// Floors are read from their constants (lib/peer-floors.mjs); a line is read by lib/compat-tags.mjs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagFindings } from "./lib/compat-tags.mjs";
import { peerFloors } from "./lib/peer-floors.mjs";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

// Source a fallback can live in. This check's own files spell example tags, which a raised floor would read as dead.
const SOURCES = ["*.ts", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs", "*.vue", "*.rs", "*.kt", "*.swift", "*.sh"];
const OWN = new Set(["_tools/checks/compat-tags.mjs", "_tools/checks/compat-tags.test.mjs", "_tools/checks/lib/compat-tags.mjs"]);

let floors;
try {
    floors = peerFloors();
} catch (error) {
    cannotMeasure(`compat-tags: ${error.message}`);
}

const problems = [];
let tags = 0;
const files = subjectFiles(...SOURCES).filter((path) => !OWN.has(path));
for (const path of files) {
    const text = readFileSync(join(root, path), "utf8");
    if (!text.includes("compat(")) {
        continue;
    }
    tags += (text.match(/\bcompat\([a-z][a-z0-9-]*<[^()\n]*\):/gu) ?? []).length;
    problems.push(...tagFindings(text, floors).map(({ line, tag, problem }) => `${path}:${line}  ${tag}: ${problem}`));
}

finish([["Compat tags that are dead, unknown or malformed", problems]], [
    `compat tags: ${tags} in ${files.length} files, each above its peer's floor (${[...floors].map(([peer, floor]) => `${peer} ${floor}`).join(", ")})`,
]);
