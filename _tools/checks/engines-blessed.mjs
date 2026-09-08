#!/usr/bin/env node
// engines.json is read fleet-wide, hourly, with no build or review gate of its own, so each blessed version must equal
// this repo's own pin for that engine and never fall below the runtime floor in
// _sandbox/sandbox/src/engines/engine-descriptors.ts. Notes and the advisory `minimum` field are unchecked.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);
const packs = join(root, "_sandbox", "sandbox", "image-packs");

const read = (path) => readFileSync(path, "utf8");

// Expects exactly one capture: a pack naming its version zero times or twice has a broken pin (mirrors the daemon's
// packPin).
const soleMatch = (text, pattern, what) => {
    const found = [...text.matchAll(pattern)].map((match) => match[1]);
    if (found.length !== 1) {
        return { error: `${what}: expected exactly one version, found ${found.length}` };
    }
    return { version: found[0] };
};

const pins = {
    claude: () => soleMatch(read(join(root, "pnpm-workspace.yaml")), /^ {2}"@anthropic-ai\/claude-agent-sdk": (\S+)$/gm, "the catalog pin"),
    codex: () => soleMatch(read(join(packs, "codex.Dockerfile")), /@openai\/codex@(\S+)/g, "image-packs/codex.Dockerfile"),
    cursor: () => soleMatch(read(join(packs, "cursor.Dockerfile")), /@cursor\/sdk@(\S+)/g, "image-packs/cursor.Dockerfile"),
    opencode: () => soleMatch(read(join(packs, "opencode.Dockerfile")), /opencode-ai@(\S+)/g, "image-packs/opencode.Dockerfile"),
    translator: () => soleMatch(read(join(packs, "translator.Dockerfile")), /version=(\S+)/g, "image-packs/translator.Dockerfile"),
};

const list = JSON.parse(read(join(root, "engines.json")));
const problems = [];

for (const [id, pin] of Object.entries(pins)) {
    const entry = list.engines?.[id];
    if (entry === undefined) {
        problems.push(`engines.json blesses no version for ${id}; every engine this repo pins has to be listed`);
        continue;
    }
    const { version, error } = pin();
    if (error !== undefined) {
        problems.push(error);
        continue;
    }
    if (entry.blessed !== version) {
        problems.push(
            `engines.json blesses ${id}@${entry.blessed}, but this repository pins ${version}. ` +
                `Blessed means "this repo's suite ran against it": move the pin first, let CI go green, then bless it.`,
        );
    }
}

// Catches the reverse: a listed engine this repo has no pin for would ship a version nobody here has run.
for (const id of Object.keys(list.engines ?? {})) {
    if (pins[id] === undefined) {
        problems.push(`engines.json lists ${id}, which is not an engine this repository pins`);
    }
}

if (problems.length > 0) {
    console.error(`engines.json does not match this repository:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
}

console.log(`engines.json: ${Object.keys(list.engines).length} blessed versions match this repository's pins`);
