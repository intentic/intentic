// Pins the two string rewrites a bump rides on, because both edit files nothing else in this repo can regenerate:
// pnpm-workspace.yaml (every version in the catalog) and engines.json (what the whole fleet runs). A rewrite that hits
// one line too many is not caught by the engines check afterwards — it would be caught by whatever breaks next.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENGINE_PINS, readPins, rewrite, withBlessed } from "./engine-pins.mjs";

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
        assert.match(pin.blessed, /^\d+(\.\d+)+$/, `${id} has no blessed version to read`);
        assert.match(pin.tracked, /^\d+(\.\d+)+$/, `${id} has no tracked version to read`);
    }
});
