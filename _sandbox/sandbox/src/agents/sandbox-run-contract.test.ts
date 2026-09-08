import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { expect, test } from "vitest";

// Walks the repo for anything that hand-rolls the sandbox container's run shape (a container started with the workspace
// volume at /work) instead of composing from @intentic/sandbox-run or using the image's own CLI verb.

const REPO_ROOT = repoRoot(import.meta.url);

// Signature of a hand-rolled run: workspace volume mounted at /work; closers span every mount dialect.
const WORK_MOUNT = /(?::\/work["'`\s\\]|:\/work$)/m;
const STARTS_CONTAINER = /docker run |image: /;

// An import of the contract is the guarantee: the splice is checked by that consumer's own unit tests.
const CONTRACT = /@intentic\/sandbox-run/;

// Positive floor: consumers that must still speak the protocol after a refactor. All verbs now run through ic.
const VERB = "sandbox run-command";
const RUST_CONTRACT = "_sandbox/ic/src/contract.rs";
const SHIMS: readonly (readonly [string, string])[] = [
    ["_site/site/public/scripts/connect.sh", 'sandbox connect "$@"'],
    ["_site/site/public/scripts/connect-host.sh", "machine enroll"],
    ["_site/site/public/scripts/recreate.sh", "sandbox rebuild"],
    ["_site/site/public/scripts/connect.ps1", "'sandbox', 'connect'"],
    ["_site/site/public/scripts/recreate.ps1", "sandbox rebuild"],
];
const CONTRACT_IMPORTERS = ["_deploy/providers/src/host/workspace.ts", "_editor/web/src/features/setup/setupCompose.ts"];

// .rs is scanned like the scripts: ic executes what the image emits, so a Rust file stating the shape is drift.
const SCANNED = new Set([".sh", ".ps1", ".ts", ".mjs", ".yml", ".yaml", ".rs"]);

const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
        entries.map(async (entry) => {
            if (entry.isDirectory()) {
                // `target` is cargo's build tree; generated code, not a creation path.
                return entry.name.startsWith(".") || entry.name === "target" || IGNORED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
            }
            return SCANNED.has(entry.name.slice(entry.name.lastIndexOf("."))) ? [join(dir, entry.name)] : [];
        }),
    );
    return found.flat();
};

test("no file in the repo hand-rolls a sandbox container run: TS composes from the contract, scripts use the verb", async () => {
    // Test files describe the shape to assert it; the contract lib is the shape.
    const files = (await walk(REPO_ROOT)).filter((file) => !file.endsWith(".test.ts") && !file.includes("_shared/sandbox-run/"));
    // One batch, not one await per file, to avoid timing out on a whole-repo scan.
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
}, 20_000);

test("every creation flow still speaks the contract: the positive floor under the discovery above", async () => {
    // Verbs are invoked as argv elements in ic, so the space-joined VERB never appears literally.
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
