// Pins which files release-compress.mjs gives a .gz copy (every binary a device downloads, never a copy, the sums or
// their signature) and that a copy unpacks to its binary.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { binariesIn, writeCopy } from "./release-compress.mjs";

const tree = (files) => {
    const root = mkdtempSync(join(tmpdir(), "release-compress-"));
    for (const [path, contents] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), contents);
    }
    return root;
};

test("every downloaded binary gets a copy, and nothing else does", () => {
    const root = tree({
        "_devices/machine/dist-bin/intentic-machine-linux-amd64": "agent",
        "_devices/machine/dist-bin/intentic-machine-linux-amd64.gz": "an earlier copy",
        "_devices/keyring/dist-bin/intentic-keyring-windows-amd64.exe": "keyring",
        "_devices/win-launcher/dist-bin/intentic-launch-windows-amd64.exe": "launcher",
        "_sandbox/ic/dist-bin/ic-darwin-arm64": "ic",
        "_sandbox/ic/dist-bin/SHA256SUMS": "sums",
        "_sandbox/ic/dist-bin/.DS_Store": "",
        "_editor/desktop-app/dist-bin/Intentic-1.338.0-x64-setup.exe": "installer",
    });
    assert.deepEqual(
        binariesIn(root).map((path) => path.slice(root.length + 1)),
        [
            "_devices/machine/dist-bin/intentic-machine-linux-amd64",
            "_devices/keyring/dist-bin/intentic-keyring-windows-amd64.exe",
            "_devices/win-launcher/dist-bin/intentic-launch-windows-amd64.exe",
            "_sandbox/ic/dist-bin/ic-darwin-arm64",
        ],
    );
});

test("a copy unpacks to its binary, byte for byte", async () => {
    const root = tree({ "_sandbox/ic/dist-bin/ic-linux-amd64": "ic ".repeat(10_000) });
    const path = join(root, "_sandbox/ic/dist-bin/ic-linux-amd64");
    await writeCopy(path);
    assert.equal(gunzipSync(readFileSync(`${path}.gz`)).toString(), "ic ".repeat(10_000));
});
