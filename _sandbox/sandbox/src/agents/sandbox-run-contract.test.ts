import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { expect, test } from "vitest";

/* NOTHING HAND-ROLLS THE SANDBOX CONTAINER'S RUN: enforced by discovery, not by a list.
 *
 * The docker-run shape (names, volumes, capability posture, env allowlist) is the run contract
 * (@intentic/sandbox-run). TS creation paths import it; the standalone scripts execute what the image's own
 * CLI emits (`intentic sandbox run-command`). Before that existed, six creation paths in four dialects each
 * restated the shape behind "keep in lockstep" comments, and SYS_ADMIN reached one path, then five, then
 * all of them, across three commits, while every ordinarily-created sandbox silently lost turn isolation.
 * Both misses were DISCOVERY failures: the fix that enumerated five paths missed the sixth.
 *
 * So this test walks the repo and recognizes a hand-rolled creation path by its SHAPE: starting a container
 * with the workspace volume mounted at /work. A TS file may match only when it composes from the contract; a
 * script or compose file may not match at all, because scripts have the verb. A seventh path added anywhere,
 * in any dialect, fails here without anyone remembering this test exists. */

const REPO_ROOT = repoRoot(import.meta.url);

// The signature of stating the run shape yourself: starting a container with the workspace volume at /work.
// Nothing else in the repo mounts that target: backup/restore/tunnel/dind runs mount their own dirs. The
// closers cover every dialect the mount appears in: a quote (scripts), whitespace/line-end (compose YAML), a
// backslash continuation (multi-line docker run), and a BACKTICK: the compose generator writes the mount
// inside a template literal, and an earlier version of this class missed exactly that file while a count
// assertion still passed. Six was still six; it was the wrong six.
const WORK_MOUNT = /(?::\/work["'`\s\\]|:\/work$)/m;
const STARTS_CONTAINER = /docker run |image: /;

// A TS match must compose from the contract; presence of the import IS the guarantee, because the splice is
// then checked by that consumer's own unit tests (setupCompose.test.ts renders the mount from the contract's
// names, which is why the generator legitimately matches the signature).
const CONTRACT = /@intentic\/sandbox-run/;

// The consumers that must SPEAK the protocol, named as a positive floor: discovery proves nobody hand-rolls
// the shape, and this proves the flows still produce a container at all: losing a call site to a refactor
// must not read as "nothing left to check". The verbs are called from ONE place now: the ic host-side CLI
// (Rust); the shims' floor is that they still hand over to ic at all.
const VERB = "sandbox run-command";
const RUST_CONTRACT = "_sandbox/ic/src/contract.rs";
const SHIMS: readonly (readonly [string, string])[] = [
    ["_site/site/public/scripts/connect.sh", 'sandbox connect "$@"'],
    ["_site/site/public/scripts/connect-host.sh", "machine enroll"],
    ["_site/site/public/scripts/recreate.sh", "sandbox rebuild"],
    ["_site/site/public/scripts/connect.ps1", "'sandbox', 'connect'"],
    ["_site/site/public/scripts/recreate.ps1", "sandbox rebuild"],
];
const CONTRACT_IMPORTERS = ["_deploy/providers/src/host/workspace.ts", "_editor/web/src/pages/setupCompose.ts"];

// .rs is scanned like the script dialects: ic executes what the image emits, so a Rust file that states the
// run shape itself is exactly the drift this test exists to catch.
const SCANNED = new Set([".sh", ".ps1", ".ts", ".mjs", ".yml", ".yaml", ".rs"]);

const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
        entries.map(async (entry) => {
            if (entry.isDirectory()) {
                // `target` is cargo's build tree (ic, the desktop crate): generated code, not a creation path.
                return entry.name.startsWith(".") || entry.name === "target" || IGNORED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
            }
            return SCANNED.has(entry.name.slice(entry.name.lastIndexOf("."))) ? [join(dir, entry.name)] : [];
        }),
    );
    return found.flat();
};

test("no file in the repo hand-rolls a sandbox container run: TS composes from the contract, scripts use the verb", async () => {
    // Test files describe the shape in order to assert it; the contract lib is the shape.
    const files = (await walk(REPO_ROOT)).filter((file) => !file.endsWith(".test.ts") && !file.includes("_sandbox/sandbox-run/"));
    // One batch, not one await per file: this scan timed out beside comment-refs.test.ts, on the same runner
    // and for the same reason, and that file's read carries the measurements.
    const sources = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8").catch(() => "")] as const));

    for (const [file, content] of sources) {
        if (!WORK_MOUNT.test(content) || !STARTS_CONTAINER.test(content)) {
            continue;
        }
        const rel = file.slice(REPO_ROOT.length + 1);
        if (file.endsWith(".ts") || file.endsWith(".mjs")) {
            expect(CONTRACT.test(content), `${rel}: a TS creation path must compose its run from @intentic/sandbox-run`).toBe(true);
            continue;
        }
        expect.fail(`${rel}: hand-rolled sandbox docker run — execute \`intentic ${VERB}\` (the image speaks the run contract) instead`);
    }
    // Stated for the same reason comment-refs.test.ts states one: a whole-repo scan is not what vitest's 5s
    // default is sized for, and both suites failed the same run on runner load rather than on a real finding.
}, 20_000);

test("every creation flow still speaks the contract: the positive floor under the discovery above", async () => {
    // ic is where the verbs are invoked (argv elements, so the space-joined VERB never appears literally).
    const rust = await readFile(join(REPO_ROOT, RUST_CONTRACT), "utf8");
    expect(rust.includes('"run-command"'), `${RUST_CONTRACT}: must ask the image for its run command (\`intentic ${VERB}\`)`).toBe(true);
    expect(rust.includes('"host-probes"'), `${RUST_CONTRACT}: must ask the image which host probes to run`).toBe(true);
    for (const [shim, handover] of SHIMS) {
        const content = await readFile(join(REPO_ROOT, shim), "utf8");
        expect(content.includes(handover), `${shim}: must hand its flow over to ic (\`${handover}\`)`).toBe(true);
    }
    for (const importer of CONTRACT_IMPORTERS) {
        const content = await readFile(join(REPO_ROOT, importer), "utf8");
        expect(CONTRACT.test(content), `${importer}: must import @intentic/sandbox-run`).toBe(true);
    }
});
