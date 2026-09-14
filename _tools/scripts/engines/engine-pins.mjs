// WHERE EACH ENGINE'S VERSION IS WRITTEN IN THIS REPOSITORY, once. The CI check reads this to hold engines.json to the
// pins; the bumper writes through it. A pin site listed in one of those and not the other is exactly the drift this
// module exists to make impossible, which is why neither keeps a table of its own.
//
// Two versions per engine, because for two of them they differ:
//   tracked — what this repo asks upstream for and what the catalog carries (@openai/codex-sdk, @anthropic-ai/…).
//   blessed — the version of the program a sandbox actually runs, which is what engines.json names. Codex's is the CLI
//             its SDK depends on, a different number from the SDK's own.
// Everything here is plain file reading: no install, no YAML parser, no network, since the check runs on a bare
// checkout before anything is installed.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";

export const root = repoRoot(import.meta.url);

const WORKSPACE = "pnpm-workspace.yaml";
const pack = (name) => join("_sandbox", "sandbox", "image-packs", `${name}.Dockerfile`);

// A pin site: one file, one pattern whose sole capture group is the version, and the exact number of times it must
// match. `count` is exact on purpose — a pattern that matches zero times or five is a pin whose shape moved, and
// reading it as "no pin" is how a bump silently half-lands.
// INVARIANT every pattern here relies on: the capture is the last occurrence of its own text inside the match, which is
// what lets a rewrite find it without a second capture group.
const site = (file, pattern, count, carries = "blessed") => ({ file, pattern, count, carries });

// `@openai/codex-sdk` pins its CLI exactly; packs.integration.test.ts holds the pack to that dependency, so the pack's
// version is derived from the SDK rather than chosen.
const codexCliOf = async (sdkVersion, fetchManifest) => {
    const manifest = await fetchManifest("@openai/codex-sdk", sdkVersion);
    const pinned = manifest?.dependencies?.["@openai/codex"];
    if (typeof pinned !== "string") {
        throw new Error(`@openai/codex-sdk@${sdkVersion} declares no @openai/codex dependency to pin the pack to`);
    }
    return pinned;
};

export const ENGINE_PINS = [
    {
        id: "claude",
        label: "Claude Code",
        // The daemon imports this SDK and spawns the CLI it ships; one npm package carries both.
        upstream: { kind: "npm", package: "@anthropic-ai/claude-agent-sdk" },
        sites: [
            site(WORKSPACE, /^ {2}"@anthropic-ai\/claude-agent-sdk": (\S+)$/gm, 1),
            // pnpm holds a just-published version back until it has aged; the SDK and its eight platform packages are
            // excused by exact name@version, so the exclusions are part of the pin, not a separate chore.
            site(WORKSPACE, /^ {2}- '@anthropic-ai\/claude-agent-sdk(?:-[a-z0-9-]+)?@(\S+)'$/gm, 9),
        ],
    },
    {
        id: "codex",
        label: "Codex",
        upstream: { kind: "npm", package: "@openai/codex-sdk" },
        blessedOf: codexCliOf,
        sites: [site(WORKSPACE, /^ {2}"@openai\/codex-sdk": (\S+)$/gm, 1, "tracked"), site(pack("codex"), /@openai\/codex@(\S+) /g, 1)],
    },
    {
        id: "cursor",
        label: "Cursor",
        // Never baked into a published image (its licence grants no redistribution); the pack installs it on the
        // owner's own machine, at the version the daemon compiled against.
        upstream: { kind: "npm", package: "@cursor/sdk" },
        sites: [site(WORKSPACE, /^ {2}"@cursor\/sdk": (\S+)$/gm, 1), site(pack("cursor"), /@cursor\/sdk@(\S+) /g, 1)],
    },
    {
        id: "opencode",
        label: "OpenCode",
        // The SDK and the CLI are two packages released as one version; a version only one of them published would
        // fail the lockstep test, so both have to have it.
        upstream: { kind: "npm", package: "@opencode-ai/sdk", alsoPublished: ["opencode-ai"] },
        sites: [site(WORKSPACE, /^ {2}"@opencode-ai\/sdk": (\S+)$/gm, 1), site(pack("opencode"), /opencode-ai@(\S+) /g, 1)],
    },
    {
        id: "translator",
        label: "Subscription translator",
        upstream: { kind: "github-release", repo: "router-for-me/CLIProxyAPI" },
        sites: [site(pack("translator"), /version=(\S+)/g, 1)],
    },
];

export const enginePin = (id) => ENGINE_PINS.find((engine) => engine.id === id);

const readFile = (file) => readFileSync(join(root, file), "utf8");

// Every version a site carries, in file order; the caller decides whether the count is the one promised.
const matchesIn = (text, pattern) => [...text.matchAll(pattern)].map((match) => match[1]);

// What one site currently pins, or the sentence saying why it cannot be read. Never throws: the check reports every
// broken site at once rather than dying on the first.
const readSite = (engine, spot) => {
    let found;
    try {
        found = matchesIn(readFile(spot.file), spot.pattern);
    } catch (error) {
        return { problem: `${spot.file}: cannot be read for ${engine.id}'s pin (${error.message})` };
    }
    if (found.length !== spot.count) {
        return { problem: `${spot.file}: ${engine.id}'s pin should match ${spot.count} time(s), it matched ${found.length}` };
    }
    const distinct = [...new Set(found)];
    if (distinct.length !== 1) {
        return { problem: `${spot.file}: ${engine.id} is pinned to ${distinct.join(" and ")} in one file; a pin is one version` };
    }
    return { version: distinct[0] };
};

// What this checkout pins for one engine: the tracked version, the blessed one, and every site that disagreed. Sites
// carrying the same version must agree — that is the lockstep the pack tests assert at runtime, caught here first.
export const readPin = (engine) => {
    const problems = [];
    const versions = { tracked: undefined, blessed: undefined };
    for (const spot of engine.sites) {
        const { version, problem } = readSite(engine, spot);
        if (problem !== undefined) {
            problems.push(problem);
            continue;
        }
        const seen = versions[spot.carries];
        if (seen !== undefined && seen !== version) {
            problems.push(`${spot.file} pins ${engine.id} at ${version} where another site says ${seen}; they move together`);
            continue;
        }
        versions[spot.carries] = version;
    }
    // An engine whose sites all carry one version has no separate tracked number; the blessed one is both.
    return { ...versions, tracked: versions.tracked ?? versions.blessed, problems };
};

export const readPins = () => Object.fromEntries(ENGINE_PINS.map((engine) => [engine.id, readPin(engine)]));

// Replaces the captured version in every match, relying on the invariant above: the capture is the last occurrence of
// its own text within the match. Returns the count so the caller can refuse a rewrite that hit the wrong number of
// lines rather than committing it. Exported for its own test: this is the function that can corrupt pnpm-workspace.yaml.
export const rewrite = (text, pattern, version) => {
    let count = 0;
    const next = text.replace(pattern, (whole, captured) => {
        count += 1;
        const at = whole.lastIndexOf(captured);
        return `${whole.slice(0, at)}${version}${whole.slice(at + captured.length)}`;
    });
    return { text: next, count };
};

// Writes one engine's versions into every site that carries them. All-or-nothing per file: a site that matched the
// wrong number of times throws before anything is written, since a half-applied pin passes no check and reads as a
// deliberate mismatch.
export const writePin = (engine, { tracked, blessed }) => {
    const versions = { tracked, blessed };
    const byFile = new Map();
    for (const spot of engine.sites) {
        const version = versions[spot.carries];
        if (version === undefined) {
            throw new Error(`${engine.id}: no ${spot.carries} version to write into ${spot.file}`);
        }
        const before = byFile.get(spot.file) ?? readFile(spot.file);
        const { text, count } = rewrite(before, spot.pattern, version);
        if (count !== spot.count) {
            throw new Error(`${engine.id}: ${spot.file} matched ${count} time(s), expected ${spot.count}; the pin's shape moved, refusing to write`);
        }
        byFile.set(spot.file, text);
    }
    for (const [file, text] of byFile) {
        writeFileSync(join(root, file), text);
    }
    return [...byFile.keys()];
};

// The version of the program to bless, given the version this repo tracks: the same number for every engine but codex,
// whose CLI is pinned by its SDK. Needs the network, so only the bumper calls it — never the checkout-only check.
export const blessedFor = async (engine, tracked, fetchManifest) =>
    engine.blessedOf === undefined ? tracked : engine.blessedOf(tracked, fetchManifest);

const LIST = join(root, "engines.json");

export const readBlessedList = () => JSON.parse(readFileSync(LIST, "utf8"));

// One engine's blessed version moved in place, by text, so engines.json's comments, key order and 4-space shape survive
// a bump that a JSON round-trip would flatten. Scoped to the first `blessed` inside that engine's own object, which is
// what stops it rewriting the neighbour below when an engine has no such key.
export const withBlessed = (text, id, version) => {
    const pattern = new RegExp(`("${id}":\\s*\\{[^}]*?"blessed":\\s*")([^"]+)(")`, "s");
    if (!pattern.test(text)) {
        throw new Error(`engines.json has no "blessed" for ${id} to move`);
    }
    return text.replace(pattern, `$1${version}$3`);
};

export const writeBlessed = (id, version) => writeFileSync(LIST, withBlessed(readFileSync(LIST, "utf8"), id, version));
