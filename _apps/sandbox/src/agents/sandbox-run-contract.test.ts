import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SANDBOX_CAPABILITIES } from "@intentic/constants";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { expect, test } from "vitest";

/* EVERY WAY A SANDBOX CONTAINER CAN BE CREATED GRANTS THE SAME POSTURE — enforced by discovery, not by a list.
 *
 * The sandbox workspace container is started from six places in four dialects: the platform provider's docker
 * run over SSH, the compose generator, and four curl-served/hand-run shell scripts (plus a PowerShell mirror).
 * The TS paths import SANDBOX_CAPABILITIES and cannot drift; the scripts are standalone files that import
 * nothing, so this test is their compiler.
 *
 * Discovery is the point. When SYS_ADMIN was first added it went to ONE path, and every sandbox created the
 * ordinary way silently lost turn isolation; the fix that followed enumerated five paths and missed the
 * sixth (dev-sandbox.sh), so "recreate the sandbox to restore isolation" recreated it through the one door
 * still missing the flag — twice. A test that walks the repo and recognizes a creation path by its SHAPE
 * (a docker run / compose service that mounts the workspace volume at /work) cannot repeat that mistake:
 * a NEW creation path added anywhere fails here until it grants the shared posture, without anyone
 * remembering this test exists. */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

// What makes a file a sandbox-container creation path: it starts a container with the workspace volume at
// /work. Nothing else in the repo mounts that target — backup/restore/tunnel/dind runs mount their own dirs.
// The closers cover every dialect the mount appears in: a quote (scripts), whitespace/line-end (compose
// YAML), a backslash continuation (multi-line docker run), and a BACKTICK — the compose generator writes the
// mount inside a template literal, and the first version of this class missed exactly that file while the
// count assertion still passed. Six was still six; it was the wrong six.
const WORK_MOUNT = /(?::\/work["'`\s\\]|:\/work$)/m;
const STARTS_CONTAINER = /docker run |image: /;

// The dialects a creation path writes its capability grant in.
const CLI_GRANT = (cap: string): RegExp => new RegExp(String.raw`--cap-add=${cap}\b`);
const COMPOSE_GRANT = (cap: string): RegExp => new RegExp(String.raw`cap_add:.*\b${cap}\b`);
// A TS path composes its run from the shared constant — presence of the identifier IS the guarantee, since
// the splice is then checked by its own unit tests (workspace.test.ts, setupCompose.test.ts).
const TS_GRANT = /SANDBOX_CAPABILITIES/;

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

test("every sandbox creation path in the repo grants the shared capability posture", async () => {
    const files = await walk(REPO_ROOT);
    const creators: { file: string; content: string }[] = [];
    for (const file of files) {
        // This test recognizes itself and the redirect tests by the same signature — skip test files.
        if (file.endsWith(".test.ts")) {
            continue;
        }
        const content = await readFile(file, "utf8").catch(() => "");
        if (WORK_MOUNT.test(content) && STARTS_CONTAINER.test(content)) {
            creators.push({ file, content });
        }
    }
    // The seven known today: the provider, the compose generator, four shell scripts, one PowerShell mirror.
    // GREATER-or-equal on purpose: an eighth path should fail the grant assertions below if it forgets the
    // posture, not this count — but fewer means the discovery signature broke and the test went blind, which
    // must never pass silently.
    expect(creators.length, creators.map((c) => c.file.slice(REPO_ROOT.length + 1)).join(", ")).toBeGreaterThanOrEqual(7);
    for (const { file, content } of creators) {
        const rel = file.slice(REPO_ROOT.length + 1);
        if (file.endsWith(".ts") || file.endsWith(".mjs")) {
            expect(TS_GRANT.test(content), `${rel}: a TS creation path must compose its run from SANDBOX_CAPABILITIES`).toBe(true);
            continue;
        }
        for (const cap of SANDBOX_CAPABILITIES) {
            const grant = file.endsWith(".yml") || file.endsWith(".yaml") ? COMPOSE_GRANT(cap) : CLI_GRANT(cap);
            expect(grant.test(content), `${rel}: missing ${cap} — every sandbox creation path grants the shared posture`).toBe(true);
        }
    }
});
