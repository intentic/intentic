// Run the installer with npm stood in for: the platform build must be a required, version-matched install target,
// and a failed download must keep the provider gate red rather than disappearing as an optional dependency.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { repoRoot } from "../../constants/src/node.mjs";

const script = join(import.meta.dirname, "install-provider-clis.sh");
const npmStub = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PROVIDER_CALLS"
case "$1" in
    view) echo 9.8.7 ;;
    root) echo "$PROVIDER_PREFIX" ;;
    install)
        if [[ "$*" == *"@opencode/cli@"* && "\${PROVIDER_DOWNLOAD_FAILS:-}" == 1 ]]; then
            echo "required platform download failed" >&2
            exit 1
        fi
        ;;
esac
`;

const install = (args = [], arch = "x64", fails = false) => {
    const root = mkdtempSync(join(tmpdir(), "provider-cli-test-"));
    try {
        const log = join(root, "calls");
        for (const [name, source] of Object.entries({
            npm: npmStub,
            node: `#!/usr/bin/env bash\nif [ "$1" = -p ]; then echo "$PROVIDER_ARCH"; fi\n`,
            codex: "#!/usr/bin/env bash\nexit 0\n",
            opencode: "#!/usr/bin/env bash\nexit 0\n",
            sleep: "#!/usr/bin/env bash\nexit 0\n",
        })) {
            const path = join(root, name);
            writeFileSync(path, source);
            chmodSync(path, 0o755);
        }
        const result = spawnSync("bash", [script, ...args], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${root}:${process.env.PATH}`,
                PROVIDER_CALLS: log,
                PROVIDER_PREFIX: root,
                PROVIDER_ARCH: arch,
                PROVIDER_DOWNLOAD_FAILS: fails ? "1" : "0",
            },
        });
        return { ...result, calls: readFileSync(log, "utf8").trim().split("\n") };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

// Read the actual pin where the script reads it, rather than keeping a second version in the fixture.
const pack = join(repoRoot(import.meta.url), "_sandbox/sandbox/image-packs/opencode.Dockerfile");
const version = /@opencode\/cli@([\d.]+)/.exec(readFileSync(pack, "utf8"))[1];
const x64Platform = /\bavx2\b/.test(readFileSync("/proc/cpuinfo", "utf8")) ? "linux-x64" : "linux-x64-baseline";

for (const [arch, platform] of [
    ["x64", x64Platform],
    ["arm64", "linux-arm64"],
]) {
    test(`${arch} installs one required platform build at the pack's pin`, () => {
        const result = install([], arch);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
            result.calls.filter((call) => call.startsWith("install") && call.includes("@opencode/")),
            [`install -g --foreground-scripts --omit=optional @opencode/cli-${platform}@${version} @opencode/cli@${version}`],
        );
    });
}

test("the canary resolves the launcher's latest once and pins its platform build to the same release", () => {
    const result = install(["--latest"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
        result.calls.filter((call) => call.includes("@opencode/")),
        [
            "view @opencode/cli@latest version",
            `install -g --foreground-scripts --omit=optional @opencode/cli-${x64Platform}@9.8.7 @opencode/cli@9.8.7`,
        ],
    );
});

test("a platform download that keeps failing stops the gate before the next provider", () => {
    const result = install([], "x64", true);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /required platform download failed/);
    assert.match(result.stderr, /did not install in three tries/);
    assert.deepEqual(
        result.calls.filter((call) => call.startsWith("install") && call.includes("@opencode/")),
        Array.from(
            { length: 3 },
            () => `install -g --foreground-scripts --omit=optional @opencode/cli-${x64Platform}@${version} @opencode/cli@${version}`,
        ),
    );
    assert.equal(
        result.calls.some((call) => call.includes("@cursor/sdk")),
        false,
    );
});
