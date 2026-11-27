// Shared engine pin table: CI checks engines.json against it and the bumper writes through it to prevent drift.
// `tracked` is the upstream/catalog package version; `blessed` is the running program version in engines.json.
// Codex's CLI and SDK versions differ. Reads local files without installs, YAML parsing or network for bare-checkout checks.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../constants/src/node.mjs";
import { releaseAssetUrl, sha256Of } from "./upstream.mjs";

export const root = repoRoot(import.meta.url);

const WORKSPACE = "pnpm-workspace.yaml";
const pack = (name) => join("_sandbox", "sandbox", "image-packs", `${name}.Dockerfile`);

// A pin site: one file, one pattern whose sole capture group is the version, and the exact number of times it must
// match. `count` is exact on purpose — a pattern that matches zero times or five is a pin whose shape moved, and
// reading it as "no pin" is how a bump silently half-lands.
// INVARIANT every pattern here relies on: the capture is the last occurrence of its own text inside the match, which is
// what lets a rewrite find it without a second capture group.
const site = (file, pattern, count, carries = "blessed") => ({ file, pattern, count, carries });

// What a site carrying one architecture's recorded sha256 is keyed by, in the vocabulary the release files it under.
export const checksumKey = (arch) => `sha256:${arch}`;

// A pack's per-architecture hashes, one `arch=<word>; sha=<hex>` arm of its `case` each: keyed on the release's own word
// for the build, so an arm that names one architecture to dpkg and another to the release is still found by the latter.
const checksumSites = (file, arches) =>
    arches.map((arch) => site(file, new RegExp(`\\barch=${arch}; sha=([a-f0-9]{64})\\b`, "g"), 1, checksumKey(arch)));

// CLIProxyAPI's own words for its two Linux builds (arm is `aarch64`, x86 is `amd64`), the same the daemon asks for.
const TRANSLATOR_ARCHES = ["amd64", "aarch64"];

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

// Meta versions Muse Code's SDK in lockstep with the program (@muse-code/sdk X.Y.Z pairs with Muse Code X.Y.Z), but
// the program's own version carries a build suffix only Meta's release channel names (1.4.6-R6000.1). The SDK is what
// this repo tracks; the build blessed is the one the channel serves for that same X.Y.Z, refused if it has moved on.
const MUSE_CHANNEL = "https://api.meta.ai/muse-code/channels/muse-stable";
const museBuildOf = async (sdkVersion) => {
    const response = await fetch(MUSE_CHANNEL, { headers: { accept: "application/json" } });
    const version = String((response.ok ? await response.json() : undefined)?.version ?? "");
    if (!version.startsWith(`${sdkVersion}-`)) {
        throw new Error(`Meta's Muse Code channel serves "${version}", not a build of ${sdkVersion}; bless them together once both are out`);
    }
    return version;
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
        id: "devin",
        label: "Devin",
        // Closed source like Cursor's SDK and never baked into a published image; its pack installs it on the owner's
        // own machine once a Devin account is connected. The pack is the only pin: the daemon spawns it, never imports it.
        upstream: { kind: "npm", package: "devin" },
        sites: [site(pack("devin"), / devin@(\S+) /g, 1)],
    },
    {
        id: "grok-build",
        label: "Grok Build",
        // xAI publishes neither to npm nor as GitHub releases: its installer reads the stable channel's version from a
        // pointer and fetches that version's binary, and the bumper reads the same two addresses.
        upstream: { kind: "pointer", url: "https://x.ai/cli/stable", artifact: (version) => `https://x.ai/cli/grok-${version}-linux-x86_64.gz` },
        sites: [site(pack("grok-build"), /version=(\S+)/g, 1)],
    },
    {
        id: "kimi",
        label: "Kimi Code CLI",
        // The daemon spawns it, never imports it, so the pack is the only pin.
        upstream: { kind: "npm", package: "@moonshot-ai/kimi-code" },
        sites: [site(pack("kimi"), /@moonshot-ai\/kimi-code@(\S+) /g, 1)],
    },
    {
        id: "muse",
        label: "Muse Code",
        // Closed source and never baked into a published image; its pack installs the binary on the owner's own machine
        // once a Meta account is connected. The daemon imports the SDK and spawns the program, so both are pins.
        upstream: { kind: "npm", package: "@muse-code/sdk" },
        blessedOf: museBuildOf,
        sites: [
            site(WORKSPACE, /^ {2}"@muse-code\/sdk": (\S+)$/gm, 1, "tracked"),
            // The SDK excused from pnpm's release-age hold by exact name@version, as the other freshly pinned SDKs are.
            site(WORKSPACE, /^ {2}- "@muse-code\/sdk@(\S+)"$/gm, 1, "tracked"),
            site(pack("muse"), /\bversion=([0-9][^;\s]*);/g, 1),
        ],
    },
    {
        id: "opencode",
        label: "OpenCode",
        // OpenCode 2, blessed under a key of its own: released daemons drive OpenCode 1 and read `opencode`, so a 2.x
        // number there would be installed under a client that cannot speak to it. engines.json keeps that key frozen.
        listKey: "opencode-v2",
        // The client and the CLI are two packages released as one version; a version only one of them published would
        // fail the lockstep test, so both have to have it.
        upstream: { kind: "npm", package: "@opencode/client", alsoPublished: ["@opencode/cli"] },
        sites: [
            site(WORKSPACE, /^ {2}"@opencode\/client": (\S+)$/gm, 1),
            // The client's own packages, excused from pnpm's release-age hold by exact name@version, as Claude's are.
            site(WORKSPACE, /^ {2}- "@opencode\/(?:client|protocol|schema)@(\S+)"$/gm, 3),
            site(pack("opencode"), /@opencode\/cli@(\S+) /g, 1),
        ],
    },
    {
        id: "translator",
        label: "Subscription translator",
        // The two archives the pack downloads (arm64 under CLIProxyAPI's own `aarch64` name): a release missing either
        // is one the image build would 404 on, so it is not a version until both are uploaded. Each one's sha256 is
        // recorded with the version, in engines.json for the daemon's installs and in the pack for the image's.
        upstream: {
            kind: "github-release",
            repo: "router-for-me/CLIProxyAPI",
            arches: TRANSLATOR_ARCHES,
            asset: (version, arch) => `CLIProxyAPI_${version}_linux_${arch}.tar.gz`,
        },
        sites: [site(pack("translator"), /version=(\S+)/g, 1), ...checksumSites(pack("translator"), TRANSLATOR_ARCHES)],
    },
];

export const enginePin = (id) => ENGINE_PINS.find((engine) => engine.id === id);

// The engines.json key an engine is blessed under: its id, unless a major the released daemons cannot drive moved it.
export const listKeyOf = (engine) => engine.listKey ?? engine.id;

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

// Writes one engine's versions into every site that carries them, keyed by each site's `carries` (an engine's are
// `tracked` and `blessed`; the tool pins add checksums and digests). All-or-nothing per file: a site that matched the
// wrong number of times throws before anything is written, since a half-applied pin passes no check and reads as a
// deliberate mismatch.
export const writePin = (engine, versions) => {
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

// The architectures whose builds an engine's pin downloads from its release, each of which gets a recorded sha256; none
// for an engine that is not a release asset.
const releaseArches = (engine) => (engine.upstream.kind === "github-release" ? (engine.upstream.arches ?? []) : []);

// The sha256 of every build a release engine's pin downloads, keyed by architecture, hashed from the bytes upstream
// serves at the moment the version is blessed: that moment is what the recorded hash vouches for, and every later
// download is held to it. GitHub's own per-asset digest is no trust root, since an asset uploaded again gets a new one.
// Undefined for an engine with no release builds; throws when one cannot be fetched, so a version is never blessed
// with half its hashes. Needs the network, like blessedFor.
export const releaseChecksums = async (engine, version, hashOf = sha256Of) => {
    const arches = releaseArches(engine);
    if (arches.length === 0) {
        return undefined;
    }
    const sha256 = {};
    for (const arch of arches) {
        const url = releaseAssetUrl(engine.upstream, version, arch);
        const hash = await hashOf(url);
        if (hash === undefined) {
            throw new Error(`${url} could not be hashed, so ${version} cannot be blessed with its checksums`);
        }
        sha256[arch] = hash;
    }
    return sha256;
};

// Recorded hashes as the values the pin's sites carry, for writePin.
export const checksumValues = (sha256) => Object.fromEntries(Object.entries(sha256 ?? {}).map(([arch, hash]) => [checksumKey(arch), hash]));

const SHA256 = /^[0-9a-f]{64}$/;

// What is wrong with the hashes a blessed release engine's entry records: every build its pin downloads needs one, a
// sha256 in lowercase hex, and the same one the pack verifies that build against. Empty for an engine with no release
// builds. Read by the engines check, which cannot tell a hash from the network; that the pack's hashes are the
// version's own is what the image build's sha256sum proves.
export const checksumProblems = (engine, entry, pin) => {
    const key = listKeyOf(engine);
    const problems = [];
    for (const arch of releaseArches(engine)) {
        const recorded = entry?.sha256?.[arch];
        // The test reads the value as text, so a missing hash fails it as a malformed one does.
        if (!SHA256.test(recorded)) {
            const found = recorded === undefined ? "no sha256" : `${JSON.stringify(recorded)}, which is not a sha256,`;
            problems.push(
                `engines.json records ${found} for ${key}@${entry?.blessed}'s ${arch} build. A release engine is installed only ` +
                    `against a hash recorded here; \`node _tools/scripts/engines/bump-engines.mjs --apply\` records every build's ` +
                    `with each version it blesses; one blessed before hashes were recorded needs its assets hashed into both by hand, once.`,
            );
            continue;
        }
        const packed = pin[checksumKey(arch)];
        if (packed !== undefined && packed !== recorded) {
            problems.push(
                `engines.json records ${recorded} for ${key}@${entry.blessed}'s ${arch} build, but the pack verifies ${packed}; ` +
                    `they are one hash and move together`,
            );
        }
    }
    return problems;
};

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

// One engine's recorded hashes, written beside its blessed version by text for the reason withBlessed is: replaced where
// the entry carries them, added on the line after `blessed` where it does not, in the entry's own indentation. Scoped
// to the engine's own object as withBlessed is; an entry holds no other nested object for the scope to stop at.
export const withChecksums = (text, id, sha256) => {
    const object = (indent) =>
        `{\n${Object.entries(sha256)
            .map(([arch, hash]) => `${indent}    "${arch}": "${hash}"`)
            .join(",\n")}\n${indent}}`;
    const recorded = new RegExp(`("${id}":\\s*\\{[^}]*?\\n([ \\t]*)"sha256":\\s*)\\{[^}]*\\}`, "s");
    if (recorded.test(text)) {
        return text.replace(recorded, (_whole, head, indent) => `${head}${object(indent)}`);
    }
    const blessed = new RegExp(`("${id}":\\s*\\{[^}]*?\\n([ \\t]*)"blessed":\\s*"[^"]+")`, "s");
    if (!blessed.test(text)) {
        throw new Error(`engines.json has no "blessed" for ${id} to record checksums beside`);
    }
    return text.replace(blessed, (_whole, head, indent) => `${head},\n${indent}"sha256": ${object(indent)}`);
};

// A version blessed and, for a release engine, its builds' hashes recorded, in one write: engines.json never holds a
// version beside another version's hashes.
export const writeBlessed = (id, version, sha256) => {
    const moved = withBlessed(readFileSync(LIST, "utf8"), id, version);
    writeFileSync(LIST, sha256 === undefined ? moved : withChecksums(moved, id, sha256));
};
