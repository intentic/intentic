// Pins what release-checksums.mjs lists in the release's SHA256SUMS: every asset of the directories the Release
// attaches, by its asset name, never the sums or their signature, and never two assets under one name.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../constants/src/node.mjs";
import { RELEASE_DIRS, releaseAssets, sumsText } from "./release-checksums.mjs";

const tree = (files) => {
    const root = mkdtempSync(join(tmpdir(), "release-checksums-"));
    for (const [path, contents] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), contents);
    }
    return root;
};

test("lists the agents, the keyring, ic and the launcher beside the installers, by the names the Release shows", () => {
    const root = tree({
        "_devices/machine/dist-bin/intentic-machine-linux-amd64": "agent",
        "_devices/keyring/dist-bin/intentic-keyring-linux-amd64": "keyring",
        "_devices/win-launcher/dist-bin/intentic-launch-windows-amd64.exe": "launcher",
        "_sandbox/ic/dist-bin/ic-linux-amd64": "ic",
        "_editor/desktop-app/dist-bin/Intentic-1.338.0-x64-setup.exe": "installer",
        "_editor/desktop-app/dist-bin/latest.json": "{}",
    });
    assert.deepEqual(
        releaseAssets(root).map((asset) => asset.name),
        ["Intentic-1.338.0-x64-setup.exe", "ic-linux-amd64", "intentic-keyring-linux-amd64", "intentic-launch-windows-amd64.exe", "intentic-machine-linux-amd64", "latest.json"],
    );
});

test("leaves out the sums and their signature, dotfiles, directories, and a directory that is not there", () => {
    const root = tree({
        "_sandbox/ic/dist-bin/ic-linux-amd64": "ic",
        "_editor/desktop-app/dist-bin/SHA256SUMS": "old",
        "_editor/desktop-app/dist-bin/SHA256SUMS.sig": "old",
        "_editor/desktop-app/dist-bin/.SHA256SUMS": "partial",
        "_editor/desktop-app/dist-bin/nested/file": "x",
    });
    assert.deepEqual(
        releaseAssets(root).map((asset) => asset.name),
        ["ic-linux-amd64"],
    );
});

test("refuses two assets with one name, which the Release could hold only one of", () => {
    const root = tree({ "_sandbox/ic/dist-bin/same": "a", "_editor/desktop-app/dist-bin/same": "b" });
    assert.throws(() => releaseAssets(root), /same is in both/);
});

test("writes sha256sum's text format, ./ before each name, one line per asset", () => {
    const assets = [
        { name: "ic-linux-amd64", path: "/x/ic" },
        { name: "latest.json", path: "/y/latest.json" },
    ];
    assert.equal(
        sumsText(assets, (path) => (path === "/x/ic" ? "a".repeat(64) : "b".repeat(64))),
        `${"a".repeat(64)}  ./ic-linux-amd64\n${"b".repeat(64)}  ./latest.json\n`,
    );
});

test("covers exactly the directories publish-github.sh uploads", () => {
    const publish = readFileSync(join(repoRoot(import.meta.url), "_tools/scripts/release/publish-github.sh"), "utf8");
    const uploaded = /^for f in (.+); do$/m
        .exec(publish)?.[1]
        .split(" ")
        .map((glob) => glob.replace(/\/\*$/, ""));
    assert.deepEqual(uploaded, RELEASE_DIRS);
});
