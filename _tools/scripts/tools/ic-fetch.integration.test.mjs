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

// A download that fails, or arrives and cannot be put in place, says which (intentic#49): the network's failure in curl's
// own words, a write this device refused as a write, never "did not answer" for both. No ic is installed, so each run
// ends in the stop, whose three lines the stand-in kit_stop prints.
const stopOf = (stubs) => {
    const homeDir = mkdtempSync(join(tmpdir(), "intentic-ic-fetch-stop-"));
    try {
        const bin = join(homeDir, "bin");
        mkdirSync(bin);
        mkdirSync(join(homeDir, ".intentic", "ic/bin"), { recursive: true });
        for (const [name, body] of Object.entries({ id: "printf '1000\\n'", od: "printf '7f454c46\\n'", ...stubs })) {
            writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
            chmodSync(join(bin, name), 0o755);
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
                kit_stop() { printf '%s\\n' "$@" >&2; exit 1; }
                ic_fetch`,
                "sh",
                source,
            ],
            {
                encoding: "utf8",
                timeout: 20_000,
                env: { ...process.env, HOME: homeDir, PATH: `${bin}:${process.env.PATH}`, IC: "", IC_BIN: "", IC_VERSION: "", IC_URL: "https://unused.invalid", IC_SKIP_CHECKSUM: "1", INTENTIC_IC_PATH: "" },
            },
        );
        assert.equal(result.status, 1, result.stdout);
        return { lines: result.stderr.trim().split("\n"), dest: join(homeDir, ".intentic", "ic/bin/ic") };
    } finally {
        rmSync(homeDir, { recursive: true, force: true });
    }
};

// The asset's own download writes a working stand-in ic to curl's -o; the .gz and the SHA256SUMS answer 404.
const curlDelivers = `out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; http*) url="$1" ;; esac; shift; done
case "$url" in *.gz | *SHA256SUMS) exit 22 ;; esac
printf '#!/bin/sh\\nprintf "ic 9.9.9\\\\n"\\n' > "$out"`;

test("a network failure keeps the network wording and adds curl's own", () => {
    const { lines } = stopOf({ curl: "printf 'curl: (6) Could not resolve host: unused.invalid\\n' >&2; exit 6" });
    assert.deepEqual(lines.slice(0, 2), ["ic could not be downloaded, and no copy is installed.", "unused.invalid did not answer from this device (curl: (6) Could not resolve host: unused.invalid)."]);
});

test("curl failing to write the download is a write, named by its path", () => {
    const { lines, dest } = stopOf({ curl: "printf 'curl: (23) Failure writing output to destination\\n' >&2; exit 23" });
    assert.equal(lines[0], "ic could not be installed, and no copy is installed.");
    assert.equal(lines[1], `could not write ${dest}.tmp: curl: (23) Failure writing output to destination.`);
});

test("a download that cannot be moved into place stops with mv's words, not a bare exit", () => {
    const { lines, dest } = stopOf({ curl: curlDelivers, mv: "printf 'mv: cannot move: Permission denied\\n' >&2; exit 1" });
    assert.equal(lines[0], "ic could not be installed, and no copy is installed.");
    assert.equal(lines[1], `could not write ${dest}: mv: cannot move: Permission denied.`);
});
