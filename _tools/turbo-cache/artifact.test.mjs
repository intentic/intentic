// Pins what a sandbox may put in the CI cache: task logs, re-written, and nothing a build would read. The tars here come
// from two writers, this module's own and GNU tar, so the reader is held to archives it did not write itself.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { test } from "node:test";
import { canonicalArtifact, MAX_TAR_BYTES, readTar, writeTar } from "./artifact.mjs";

const LOG = "packages/a/.turbo/turbo-typecheck.log";
const file = (path, text) => ({ path, data: Buffer.from(text) });
const artifactOf = (...files) => zstdCompressSync(writeTar(files));

// A tar GNU tar writes from a scratch tree: `files` maps a path to its content, `links` a path to its target, and
// `dirs` are directory entries of their own (listed without recursing, as turbo lists one).
const gnuTar = ({ files = {}, links = {}, dirs = [] }, format = "gnu") => {
    const root = mkdtempSync(join(tmpdir(), "turbo-cache-tar-"));
    try {
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), text);
        }
        for (const [path, target] of Object.entries(links)) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            symlinkSync(target, join(root, path));
        }
        for (const dir of dirs) {
            mkdirSync(join(root, dir), { recursive: true });
        }
        const members = [...dirs, ...Object.keys(files), ...Object.keys(links)];
        const ran = spawnSync("tar", [`--format=${format}`, "--no-recursion", "-cf", "-", "-C", root, ...members]);
        assert.equal(ran.status, 0, ran.stderr.toString());
        return zstdCompressSync(ran.stdout);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

test("a log-only entry comes back re-written, holding the same log", () => {
    const result = canonicalArtifact(artifactOf(file(LOG, "$ tsgo --noEmit\n")));
    assert.equal(result.ok, true);
    assert.deepEqual(
        readTar(zstdDecompressSync(result.body)).map((entry) => [entry.path, entry.type, entry.data.toString()]),
        [[LOG, "file", "$ tsgo --noEmit\n"]],
    );
});

test("a build's entry is refused: a dist file is not a log", () => {
    const result = canonicalArtifact(artifactOf(file("packages/a/.turbo/turbo-build.log", "built"), file("packages/a/dist/index.js", "evil()")));
    assert.equal(result.ok, false);
    assert.match(result.reason, /packages\/a\/dist\/index\.js/);
});

test("GNU tar's long names are read, and its .turbo directory entries are dropped", () => {
    const deep = `${"nested/".repeat(16)}.turbo/turbo-typecheck.log`;
    const result = canonicalArtifact(gnuTar({ files: { [deep]: "ok\n" }, dirs: [`${"nested/".repeat(16)}.turbo`] }));
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(
        result.files.map((each) => each.path),
        [deep],
    );
    assert.match(canonicalArtifact(gnuTar({ files: { [LOG]: "ok" }, dirs: ["packages/a/dist"] })).reason, /directory 'packages\/a\/dist'/);
    // And the canonical tar, which splits a long path into ustar's prefix field, reads back to the same path.
    assert.equal(readTar(zstdDecompressSync(result.body))[0].path, deep);
});

test("a PAX archive's path record is honoured, so a long name cannot hide behind it", () => {
    const result = canonicalArtifact(gnuTar({ files: { "packages/a/dist/x.js": "evil()" } }, "pax"));
    assert.equal(result.ok, false);
    assert.match(result.reason, /dist\/x\.js/);
});

test("a link at a log's path is refused, whatever it points at", () => {
    const result = canonicalArtifact(gnuTar({ links: { [LOG]: "../../dist/index.js" } }));
    assert.equal(result.ok, false);
    assert.match(result.reason, /type '2'/);
});

test("a path that climbs out or starts at the root is refused", () => {
    for (const path of ["../.turbo/turbo-typecheck.log", "/etc/.turbo/turbo-x.log", "a/./.turbo/turbo-x.log"]) {
        const result = canonicalArtifact(artifactOf(file(path, "x")));
        assert.equal(result.ok, false, path);
    }
});

test("a log line GitHub would read as a workflow command is refused", () => {
    for (const line of ["::add-mask::secret", "  ::error file=x::boom", "##[group]x", "ok\r::set-output name=a::b"]) {
        const result = canonicalArtifact(artifactOf(file(LOG, `fine\n${line}\n`)));
        assert.equal(result.ok, false, line);
        assert.match(result.reason, /workflow command/);
    }
    assert.equal(canonicalArtifact(artifactOf(file(LOG, "see a::b in the middle of a line\n"))).ok, true);
});

test("with an expected log, exactly that log and nothing beside it", () => {
    assert.equal(canonicalArtifact(artifactOf(file(LOG, "x")), { expect: LOG }).ok, true);
    assert.equal(canonicalArtifact(artifactOf(file("packages/b/.turbo/turbo-typecheck.log", "x")), { expect: LOG }).ok, false);
    assert.equal(canonicalArtifact(artifactOf(file(LOG, "x"), file("packages/b/.turbo/turbo-typecheck.log", "x")), { expect: LOG }).ok, false);
});

test("what cannot be read is refused rather than thrown: garbage, a bad checksum, an empty archive, a bomb", () => {
    assert.equal(canonicalArtifact(Buffer.from("not zstd")).ok, false);
    const tar = writeTar([file(LOG, "x")]);
    tar[0] ^= 1;
    assert.match(canonicalArtifact(zstdCompressSync(tar)).reason, /checksum/);
    assert.match(canonicalArtifact(zstdCompressSync(Buffer.alloc(1024))).reason, /no task log/);
    const bomb = canonicalArtifact(artifactOf(file(LOG, "x".repeat(MAX_TAR_BYTES + 1))));
    assert.equal(bomb.ok, false);
    assert.match(bomb.reason, /unpacks past/);
});
