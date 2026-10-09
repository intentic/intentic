// Pins the rewrites a tool bump rides on. The dangerous ones are the lines that carry two values at once: a Dockerfile
// `case` arm holding ripgrep's and jq's checksums side by side, and a `cloudflared:<version>@sha256:<digest>` reference.
// A pattern that catches its neighbour there is not noticed by the `tool-pins` check (both sites still read back one
// value each); it is noticed by an image build that refuses a checksum, after the pull request merged.
import assert from "node:assert/strict";
import { test } from "node:test";
import { versionOfTag } from "../engines/upstream.mjs";
import { TOOL_PINS, readToolPins, rewrite, toolPin } from "./tool-pins.mjs";

const patternOf = (id, carries, file) =>
    toolPin(id).sites.find((spot) => spot.carries === carries && (file === undefined || spot.file === file)).pattern;

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const ARMS = `    case "$arch" in \\
      amd64) target=x86_64-unknown-linux-musl; rg_sha=${A}; jq_sha=${B} ;; \\
      arm64) target=aarch64-unknown-linux-musl; rg_sha=${C}; jq_sha=${D} ;; \\
    esac; \\
`;

test("a checksum moves on its own architecture's arm and leaves its neighbour on the line alone", () => {
    const { text, count } = rewrite(ARMS, patternOf("jq", "sha256:amd64"), "e".repeat(64));
    assert.equal(count, 1);
    assert.match(text, new RegExp(`rg_sha=${A}; jq_sha=${"e".repeat(64)}`));
    assert.match(text, new RegExp(`rg_sha=${C}; jq_sha=${D}`));
});

test("ripgrep's arm64 checksum is found past the amd64 arm, not on it", () => {
    const { text, count } = rewrite(ARMS, patternOf("ripgrep", "sha256:arm64"), "f".repeat(64));
    assert.equal(count, 1);
    assert.match(text, new RegExp(`amd64\\) target=x86_64-unknown-linux-musl; rg_sha=${A}`));
    assert.match(text, new RegExp(`arm64\\) target=aarch64-unknown-linux-musl; rg_sha=${"f".repeat(64)}`));
});

const IMAGE = `    cloudflared: "cloudflare/cloudflared:2026.9.3@sha256:${A}",\n`;

test("a cloudflared image reference moves its tag and its digest as two values", () => {
    const file = "_deploy/state-resolver/src/lib/images.ts";
    const tagged = rewrite(IMAGE, patternOf("cloudflared", "version", file), "2026.10.0");
    const digested = rewrite(tagged.text, patternOf("cloudflared", "digest", file), B);
    assert.equal(tagged.count, 1);
    assert.equal(digested.count, 1);
    assert.equal(digested.text, `    cloudflared: "cloudflare/cloudflared:2026.10.0@sha256:${B}",\n`);
});

// The tests' own fake references (`@sha256:aaaa`) are not pins and must not read as one.
test("a reference with a fake digest is not a pin site", () => {
    const { count } = rewrite(`image: "cloudflare/cloudflared:2026.9.3@sha256:aaaa"`, patternOf("cloudflared", "version", "_deploy/state-resolver/src/lib/images.ts"), "2026.10.0");
    assert.equal(count, 0);
});

test("a release tag reads as a version only behind its declared prefix", () => {
    assert.equal(versionOfTag("v2.102.0"), "2.102.0");
    assert.equal(versionOfTag("15.2.0"), "15.2.0");
    assert.equal(versionOfTag("jq-1.8.2", "jq-"), "1.8.2");
    assert.equal(versionOfTag("docker-v29.9.0", "docker-v"), "29.9.0");
    assert.equal(versionOfTag("api/v1.53.0", "docker-v"), undefined);
});

// The check reads this too; a tool whose sites disagree, or a derived site that lost its value, has to show here.
test("every pinned tool reads back one version and every value its derivation writes", () => {
    for (const [id, pin] of Object.entries(readToolPins())) {
        assert.deepEqual(pin.problems, [], `${id}'s pins are unreadable or disagree`);
        assert.match(pin.version, /^\d+(\.\d+)+$/, `${id} has no version to read`);
        for (const carries of new Set(toolPin(id).sites.map((spot) => spot.carries))) {
            assert.notEqual(pin[carries], undefined, `${id} carries no ${carries}`);
        }
    }
    assert.ok(TOOL_PINS.length > 0);
});
