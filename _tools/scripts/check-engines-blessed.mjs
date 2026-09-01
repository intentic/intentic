#!/usr/bin/env node
/* THE GATE BEHIND THE BLESSED ENGINE LIST.
 *
 *   node _tools/scripts/check-engines-blessed.mjs      # checks engines.json against this repo, exits 1 on a breach
 *
 * WHY A GATE. engines.json is read by every sandbox on the `blessed` channel, hourly, straight off this
 * repository's main branch. That is what makes blessing a version a commit rather than a release — and it is
 * also what makes a careless edit here a fleet-wide change with no build, no review gate of its own and no
 * rollout. The word "blessed" has one meaning: this repository's own suite has run against that version. The
 * only way that claim stays true is if the file cannot name a version this repository does not itself pin.
 *
 * So each blessed version must equal the pin the repo already carries for that engine:
 *
 *   claude      the catalog pin for @anthropic-ai/claude-agent-sdk (pnpm-workspace.yaml), which is what the
 *               daemon is compiled and tested against;
 *   codex       packs/codex.Dockerfile's `@openai/codex@…`, the version the image bakes and CI exercises;
 *   cursor      packs/cursor.Dockerfile's `@cursor/sdk@…`;
 *   opencode    packs/opencode.Dockerfile's `opencode-ai@…`;
 *   translator  packs/translator.Dockerfile's `version=…`.
 *
 * Those pins are the same ones the daemon reads back at runtime as each engine's image floor
 * (_sandbox/sandbox/src/engines/engine-descriptors.ts), so this check also keeps the list and the floors from
 * drifting apart — a blessed version BELOW the floor would be a list asking sandboxes to downgrade.
 *
 * The rest of the file (notes, an advisory `minimum`) is deliberately unchecked: those are prose for a card. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");
const packs = join(root, "_sandbox", "sandbox", "packs");

const read = (path) => readFileSync(path, "utf8");

// One capture, exactly once: a pack that stops naming its version once, or starts naming it twice, is a broken
// pin rather than a pin worth guessing at (the daemon's packPin holds the same rule).
const soleMatch = (text, pattern, what) => {
    const found = [...text.matchAll(pattern)].map((match) => match[1]);
    if (found.length !== 1) {
        return { error: `${what}: expected exactly one version, found ${found.length}` };
    }
    return { version: found[0] };
};

const pins = {
    claude: () => soleMatch(read(join(root, "pnpm-workspace.yaml")), /^ {2}"@anthropic-ai\/claude-agent-sdk": (\S+)$/gm, "the catalog pin"),
    codex: () => soleMatch(read(join(packs, "codex.Dockerfile")), /@openai\/codex@(\S+)/g, "packs/codex.Dockerfile"),
    cursor: () => soleMatch(read(join(packs, "cursor.Dockerfile")), /@cursor\/sdk@(\S+)/g, "packs/cursor.Dockerfile"),
    opencode: () => soleMatch(read(join(packs, "opencode.Dockerfile")), /opencode-ai@(\S+)/g, "packs/opencode.Dockerfile"),
    translator: () => soleMatch(read(join(packs, "translator.Dockerfile")), /version=(\S+)/g, "packs/translator.Dockerfile"),
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

// The reverse direction: a listed engine the repo knows nothing about would be a version nobody here has ever
// run, shipped to every sandbox as though somebody had.
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
