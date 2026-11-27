// Pins the two string rewrites a bump rides on, because both edit files nothing else in this repo can regenerate:
// pnpm-workspace.yaml (every version in the catalog) and engines.json (what the whole fleet runs). A rewrite that hits
// one line too many is not caught by the engines check afterwards — it would be caught by whatever breaks next.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    ENGINE_PINS,
    checksumProblems,
    checksumValues,
    enginePin,
    readBlessedList,
    readPins,
    releaseChecksums,
    rewrite,
    withBlessed,
    withChecksums,
} from "./engine-pins.mjs";
import { hasAssets, releaseAssetNames } from "./upstream.mjs";

const CATALOG = ENGINE_PINS.find((engine) => engine.id === "claude").sites[0].pattern;
const EXCLUDES = ENGINE_PINS.find((engine) => engine.id === "claude").sites[1].pattern;

const WORKSPACE = `minimumReleaseAgeExclude:
  - jose@6.2.5
  - '@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.257'
  - '@anthropic-ai/claude-agent-sdk-linux-x64-musl@0.3.257'
  - '@anthropic-ai/claude-agent-sdk@0.3.257'

catalog:
  "@agentclientprotocol/sdk": 1.3.0
  "@anthropic-ai/claude-agent-sdk": 0.3.257
  "@astrojs/check": 0.9.10
`;

test("the catalog pin moves and nothing beside it does", () => {
    const { text, count } = rewrite(WORKSPACE, CATALOG, "0.3.270");
    assert.equal(count, 1);
    assert.match(text, /^ {2}"@anthropic-ai\/claude-agent-sdk": 0\.3\.270$/m);
    // The excludes carry the same version string and must not be caught by the catalog's pattern.
    assert.equal(text.match(/0\.3\.257/g).length, 3);
    assert.match(text, /"@agentclientprotocol\/sdk": 1\.3\.0/);
});

test("the release-age exclusions move as one, platform packages included", () => {
    const { text, count } = rewrite(WORKSPACE, EXCLUDES, "0.3.270");
    assert.equal(count, 3);
    assert.match(text, /- '@anthropic-ai\/claude-agent-sdk-darwin-arm64@0\.3\.270'/);
    assert.match(text, /- '@anthropic-ai\/claude-agent-sdk@0\.3\.270'/);
    // A neighbouring package pinned in the same block is not an engine's pin.
    assert.match(text, /- jose@6\.2\.5/);
    assert.match(text, /"@anthropic-ai\/claude-agent-sdk": 0\.3\.257/);
});

// The version is the last thing in each match, so the rewrite finds it by its own text; a line where that text also
// appears earlier is the case that would break a naive search.
test("a version repeated inside the same match is replaced only where it is the pin", () => {
    const line = `RUN version=1.2.3 && curl -O https://example.test/app_1.2.3_linux.tar.gz\n`;
    const { text, count } = rewrite(line, /version=(\S+)/g, "4.5.6");
    assert.equal(count, 1);
    assert.equal(text, `RUN version=4.5.6 && curl -O https://example.test/app_1.2.3_linux.tar.gz\n`);
});

const LIST = `{
    "engines": {
        "claude": {
            "blessed": "0.3.257",
            "notes": "npm @anthropic-ai/claude-agent-sdk"
        },
        "codex": {
            "blessed": "0.147.0",
            "notes": "npm @openai/codex"
        }
    }
}
`;

test("blessing one engine leaves the next one, and the file's shape, alone", () => {
    const moved = withBlessed(LIST, "claude", "0.3.270");
    assert.match(moved, /"claude": \{\n {12}"blessed": "0\.3\.270"/);
    assert.match(moved, /"codex": \{\n {12}"blessed": "0\.147\.0"/);
    assert.equal(moved.split("\n").length, LIST.split("\n").length);
});

test("blessing an engine the list does not carry refuses rather than writing somewhere else", () => {
    assert.throws(() => withBlessed(LIST, "cursor", "1.0.31"), /no "blessed" for cursor/);
});

// The check and the bumper both read this; an engine whose sites disagree has to be visible here rather than at the
// runtime skew the pack tests catch after an install.
test("every engine this repo pins reads back one version per site group", () => {
    for (const [id, pin] of Object.entries(readPins())) {
        assert.deepEqual(pin.problems, [], `${id}'s pins are unreadable or disagree`);
        // Muse Code's build carries Meta's release suffix (1.4.6-R6000.1) beside the SDK's plain version it pairs with.
        assert.match(pin.blessed, /^\d+(\.\d+)+(-R\d+(\.\d+)*)?$/, `${id} has no blessed version to read`);
        assert.match(pin.tracked, /^\d+(\.\d+)+$/, `${id} has no tracked version to read`);
    }
});

// A release GitHub published before (or without) its build's uploads is not one the pack can install.
test("a translator release counts only once both archives the pack downloads are uploaded", () => {
    const assets = releaseAssetNames(enginePin("translator").upstream);
    const named = (...names) => ({ assets: names.map((name) => ({ name })) });
    assert.equal(hasAssets({ assets: [] }, "8.0.39", assets), false);
    assert.equal(hasAssets(named("CLIProxyAPI_8.0.39_linux_amd64.tar.gz"), "8.0.39", assets), false);
    assert.equal(hasAssets(named("CLIProxyAPI_8.0.38_linux_amd64.tar.gz", "CLIProxyAPI_8.0.38_linux_aarch64.tar.gz"), "8.0.38", assets), true);
    // Engines that declare no assets are not held to any.
    assert.equal(hasAssets({ assets: [] }, "1.0.0", undefined), true);
});

// A release engine's builds are hashed as the version is blessed, and the hashes are written beside it in engines.json and
// in the pack, both by text. These pin where each lands and what a missing one reads as.
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const translator = enginePin("translator");

const TRANSLATOR_LIST = `{
    "engines": {
        "opencode-v2": {
            "blessed": "2.4.1",
            "notes": "npm @opencode/cli"
        },
        "translator": {
            "blessed": "8.1.3",
            "notes": "CLIProxyAPI GitHub release"
        }
    }
}
`;

test("a release engine's first hashes are written on the line after its blessed version, in its own indentation", () => {
    const recorded = withChecksums(TRANSLATOR_LIST, "translator", { amd64: A, aarch64: B });
    assert.equal(
        recorded,
        TRANSLATOR_LIST.replace(
            `"blessed": "8.1.3",\n`,
            `"blessed": "8.1.3",\n            "sha256": {\n                "amd64": "${A}",\n                "aarch64": "${B}"\n            },\n`,
        ),
    );
    assert.deepEqual(JSON.parse(recorded).engines["opencode-v2"], { blessed: "2.4.1", notes: "npm @opencode/cli" });
});

test("a later blessing replaces the hashes it finds rather than adding a second set", () => {
    const first = withChecksums(withBlessed(TRANSLATOR_LIST, "translator", "8.1.3"), "translator", { amd64: A, aarch64: B });
    const next = withChecksums(withBlessed(first, "translator", "8.1.7"), "translator", { amd64: C, aarch64: D });
    assert.equal(next.split("\n").length, first.split("\n").length);
    assert.deepEqual(JSON.parse(next).engines.translator, {
        blessed: "8.1.7",
        sha256: { amd64: C, aarch64: D },
        notes: "CLIProxyAPI GitHub release",
    });
});

// An entry whose last key is `blessed` has no comma after it to write the hashes behind.
test("hashes recorded beside a blessed version with nothing after it leave valid JSON", () => {
    const bare = `{\n    "engines": {\n        "translator": {\n            "blessed": "8.1.3"\n        }\n    }\n}\n`;
    assert.deepEqual(JSON.parse(withChecksums(bare, "translator", { amd64: A, aarch64: B })).engines.translator, {
        blessed: "8.1.3",
        sha256: { amd64: A, aarch64: B },
    });
});

test("an engine the list does not carry gets no hashes written somewhere else", () => {
    assert.throws(() => withChecksums(TRANSLATOR_LIST, "kimi", { amd64: A }), /no "blessed" for kimi/);
});

// The addresses the pack's curl and the daemon fetch; a hash of any other file vouches for nothing.
test("a release's builds are hashed from the files the pack downloads, one per architecture", async () => {
    const asked = [];
    const hashOf = async (url) => {
        asked.push(url);
        return url.endsWith("_amd64.tar.gz") ? A : B;
    };
    assert.deepEqual(await releaseChecksums(translator, "8.1.7", hashOf), { amd64: A, aarch64: B });
    assert.deepEqual(asked, [
        "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.1.7/CLIProxyAPI_8.1.7_linux_amd64.tar.gz",
        "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.1.7/CLIProxyAPI_8.1.7_linux_aarch64.tar.gz",
    ]);
});

test("a version one of whose builds cannot be hashed is not blessed with the other's hash alone", async () => {
    const hashOf = async (url) => (url.endsWith("_amd64.tar.gz") ? A : undefined);
    await assert.rejects(
        releaseChecksums(translator, "8.1.7", hashOf),
        new Error(
            "https://github.com/router-for-me/CLIProxyAPI/releases/download/v8.1.7/CLIProxyAPI_8.1.7_linux_aarch64.tar.gz could not be hashed, " +
                "so 8.1.7 cannot be blessed with its checksums",
        ),
    );
});

test("an engine that is no release asset records no hashes and fetches nothing", async () => {
    const hashOf = async (url) => assert.fail(`hashed ${url}`);
    assert.equal(await releaseChecksums(enginePin("claude"), "0.3.400", hashOf), undefined);
    assert.deepEqual(checksumValues(undefined), {});
});

const PACK_ARMS = `RUN version=8.1.3 \\
    && case "$(dpkg --print-architecture)" in \\
        amd64) arch=amd64; sha=${A} ;; \\
        arm64) arch=aarch64; sha=${B} ;; \\
    esac \\
`;

test("each build's hash moves on its own arm of the pack's case, found by the release's word for it", () => {
    let text = PACK_ARMS;
    for (const spot of translator.sites) {
        const values = { blessed: "8.1.7", ...checksumValues({ amd64: C, aarch64: D }) };
        const moved = rewrite(text, spot.pattern, values[spot.carries]);
        assert.equal(moved.count, 1, `${spot.carries} matched once`);
        text = moved.text;
    }
    assert.equal(text, PACK_ARMS.replace("8.1.3", "8.1.7").replace(A, C).replace(B, D));
});

test("a blessed release entry is refused without a sha256 for every build, or with one the pack does not verify", () => {
    const pin = { "sha256:amd64": A, "sha256:aarch64": B };
    assert.deepEqual(checksumProblems(translator, { blessed: "8.1.3", sha256: { amd64: A, aarch64: B } }, pin), []);
    const missing = checksumProblems(translator, { blessed: "8.1.3", sha256: { amd64: A } }, pin);
    assert.equal(missing.length, 1);
    assert.match(missing[0], /^engines\.json records no sha256 for translator@8\.1\.3's aarch64 build\. /);
    assert.equal(checksumProblems(translator, { blessed: "8.1.3" }, pin).length, 2);
    const malformed = checksumProblems(translator, { blessed: "8.1.3", sha256: { amd64: A.toUpperCase(), aarch64: B } }, pin);
    assert.match(malformed[0], new RegExp(`^engines\\.json records "${A.toUpperCase()}", which is not a sha256, for translator@8\\.1\\.3's amd64 build\\. `));
    assert.deepEqual(checksumProblems(translator, { blessed: "8.1.3", sha256: { amd64: A, aarch64: C } }, pin), [
        `engines.json records ${C} for translator@8.1.3's aarch64 build, but the pack verifies ${B}; they are one hash and move together`,
    ]);
    assert.deepEqual(checksumProblems(enginePin("claude"), { blessed: "0.3.400" }, {}), []);
});

// What the check reads on this checkout: the hashes engines.json records are the ones the pack verifies.
test("this repository's blessed translator carries both builds' hashes, the same the pack verifies", () => {
    const entry = readBlessedList().engines.translator;
    assert.deepEqual(Object.keys(entry.sha256), translator.upstream.arches);
    assert.deepEqual(checksumProblems(translator, entry, readPins().translator), []);
});
