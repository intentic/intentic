import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { expect, test } from "vitest";

/* NOTHING HAND-ROLLS THE SANDBOX CONTAINER'S RUN — enforced by discovery, not by a list.
 *
 * The docker-run shape (names, volumes, capability posture, env allowlist) is the run contract
 * (@intentic/sandbox-run). TS creation paths import it; the standalone scripts execute what the image's own
 * CLI emits (`intentic sandbox run-command`). Before that existed, six creation paths in four dialects each
 * restated the shape behind "keep in lockstep" comments — and SYS_ADMIN reached one path, then five, then
 * all of them, across three commits, while every ordinarily-created sandbox silently lost turn isolation.
 * Both misses were DISCOVERY failures: the fix that enumerated five paths missed the sixth.
 *
 * So this test walks the repo and recognizes a hand-rolled creation path by its SHAPE — starting a container
 * with the workspace volume mounted at /work. A TS file may match only when it composes from the contract; a
 * script or compose file may not match at all, because scripts have the verb. A seventh path added anywhere,
 * in any dialect, fails here without anyone remembering this test exists. */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

// The signature of stating the run shape yourself: starting a container with the workspace volume at /work.
// Nothing else in the repo mounts that target — backup/restore/tunnel/dind runs mount their own dirs. The
// closers cover every dialect the mount appears in: a quote (scripts), whitespace/line-end (compose YAML), a
// backslash continuation (multi-line docker run), and a BACKTICK — the compose generator writes the mount
// inside a template literal, and an earlier version of this class missed exactly that file while a count
// assertion still passed. Six was still six; it was the wrong six.
const WORK_MOUNT = /(?::\/work["'`\s\\]|:\/work$)/m;
const STARTS_CONTAINER = /docker run |image: /;

// A TS match must compose from the contract; presence of the import IS the guarantee, because the splice is
// then checked by that consumer's own unit tests (setupCompose.test.ts renders the mount from the contract's
// names, which is why the generator legitimately matches the signature).
const CONTRACT = /@intentic\/sandbox-run/;

// The consumers that must SPEAK the protocol, named as a positive floor: discovery proves nobody hand-rolls
// the shape, and this proves the flows still produce a container at all — losing a call site to a refactor
// must not read as "nothing left to check".
const VERB = "sandbox run-command";
const PROTOCOL_SCRIPTS = ["_apps/site/public/scripts/connect.sh", "_apps/site/public/scripts/connect.ps1", "_apps/site/public/scripts/recreate.sh"];
const CONTRACT_IMPORTERS = ["_libs/providers/src/host/workspace.ts", "_apps/web/src/pages/setupCompose.ts"];

const SCANNED = new Set([".sh", ".ps1", ".ts", ".mjs", ".yml", ".yaml"]);

const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const found = await Promise.all(
        entries.map(async (entry) => {
            if (entry.isDirectory()) {
                return entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name));
            }
            return SCANNED.has(entry.name.slice(entry.name.lastIndexOf("."))) ? [join(dir, entry.name)] : [];
        }),
    );
    return found.flat();
};

test("no file in the repo hand-rolls a sandbox container run — TS composes from the contract, scripts use the verb", async () => {
    for (const file of await walk(REPO_ROOT)) {
        // Test files describe the shape in order to assert it; the contract lib is the shape.
        if (file.endsWith(".test.ts") || file.includes("_libs/sandbox-run/")) {
            continue;
        }
        const content = await readFile(file, "utf8").catch(() => "");
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
});

test("every creation flow still speaks the contract — the positive floor under the discovery above", async () => {
    for (const script of PROTOCOL_SCRIPTS) {
        const content = await readFile(join(REPO_ROOT, script), "utf8");
        expect(content.includes(VERB), `${script}: must ask the image for its run command (\`intentic ${VERB}\`)`).toBe(true);
    }
    for (const importer of CONTRACT_IMPORTERS) {
        const content = await readFile(join(REPO_ROOT, importer), "utf8");
        expect(CONTRACT.test(content), `${importer}: must import @intentic/sandbox-run`).toBe(true);
    }
});
