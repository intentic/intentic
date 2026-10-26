import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../constants/src/node.mjs";

const source = join(repoRoot(import.meta.url), "_site/site/scripts-kit/ic-fetch.sh");

// Only the CLI's version probe runs: curl records an unexpected download, and id keeps this root-run test's install
// inside its temporary HOME. The od stand-in lets a shell fixture answer the same probe as an installed native ic.
const bootstrap = (installed, pin) => {
    const homeDir = mkdtempSync(join(tmpdir(), "intentic-ic-fetch-"));
    try {
        const bin = join(homeDir, "bin");
        const installDir = join(homeDir, ".intentic", "ic/bin");
        const dest = join(installDir, "ic");
        const log = join(homeDir, "calls");
        mkdirSync(bin);
        mkdirSync(installDir, { recursive: true });
        writeFileSync(log, "");
        for (const [path, body] of [
            [join(bin, "id"), "printf '1000\\n'"],
            [join(bin, "od"), "printf '7f454c46\\n'"],
            [join(bin, "curl"), "printf 'download\\n' >> \"$FETCH_CALLS\"; exit 1"],
            [dest, "printf 'probe\\n' >> \"$FETCH_CALLS\"; printf 'ic %s\\n' \"$FETCH_VERSION\""],
        ]) {
            writeFileSync(path, `#!/bin/sh\n${body}\n`);
            chmodSync(path, 0o755);
        }
        const result = spawnSync(
            "sh",
            [
                "-c",
                `set -eu
                . "$1"
                kit_say() { :; }
                kit_step() { :; }
                kit_warn() { :; }
                kit_settle() { :; }
                kit_stop() { exit 1; }
                cut() { printf 'cut\\n' >> "$FETCH_CALLS"; command cut "$@"; }
                ic_fetch
                printf '%s\\n' "$IC"`,
                "sh",
                source,
            ],
            {
                encoding: "utf8",
                timeout: 20_000,
                env: {
                    ...process.env,
                    HOME: homeDir,
                    PATH: `${bin}:${process.env.PATH}`,
                    IC: "",
                    IC_BIN: "",
                    IC_VERSION: pin,
                    IC_URL: "https://unused.invalid",
                    INTENTIC_IC_PATH: "",
                    FETCH_CALLS: log,
                    FETCH_VERSION: installed,
                },
            },
        );
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), dest);
        return readFileSync(log, "utf8").trim().split("\n");
    } finally {
        rmSync(homeDir, { recursive: true, force: true });
    }
};

for (const installed of ["1.2.3", "1.3.0", "2.0.0", "1.2.3-preview", "v1.2.3"]) {
    test(`a pinned bootstrap reuses ic ${installed} after one version probe`, () => {
        const pin = installed === "1.2.3-preview" ? "v1.2.3-preview" : "1.2.3";
        assert.deepEqual(bootstrap(installed, pin), ["probe"]);
    });
}

for (const [installed, pin] of [
    ["1.2.2", "1.2.3"],
    ["1.2.3-preview", "1.2.3"],
    ["1.2.x", "1.2.3"],
    ["1.2", "1.2.3"],
    ["1.2.3-preview.1", "1.2.3-preview.2"],
]) {
    test(`ic ${installed} still attempts an update to ${pin} and survives a failed download`, () => {
        assert.deepEqual(bootstrap(installed, pin), ["probe", "download", "download", "probe"]);
    });
}
