import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { packageRoot } from "@intentic/constants/node";
import { StatePlanSchema } from "@intentic/sandbox-contract/schemas/state-plan";
import { membersDocument } from "./auth/auth.js";
import { passkeysDocument } from "./auth/passkeys/passkey-store.js";
import { heldWakesDocument } from "./automations/held-wakes-store.js";
import { ownerGrantsDocument } from "./personas/owner-grants.js";
import { authRootOf } from "./state-paths.js";
import { conversionDigest, engineEpoch } from "./store/evolution/documents.js";
import { stateDocuments, stateSteps } from "./bootstrap/state-registry.js";
import { newestRunDocument } from "./store/newest-run.js";
import { version } from "./version.js";

const run = promisify(execFile);
const ENTRY = join(packageRoot(import.meta.url), "src", "state-plan.ts");
const made: string[] = [];

afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const plan = async (workspace: string, history: string): Promise<Record<string, unknown>> => {
    const { stdout } = await run(process.execPath, [ENTRY, "--workspace", workspace, "--history", history], { timeout: 120_000 });
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
};

const volumes = async (): Promise<{ workspace: string; history: string }> => {
    const base = await mkdtemp(join(tmpdir(), "state-plan-"));
    made.push(base);
    const workspace = join(base, "work");
    const history = join(base, "history");
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(history, { recursive: true })]);
    return { workspace, history };
};

// Spawned the way the host runs it in the target image, with the test runtime standing in for node; the bound is a
// hang bound for a busy runner, far above the second it takes.
test("prints one plan line naming its format, conversion set and verdict, and writes nothing", async () => {
    const { workspace, history } = await volumes();
    const line = await plan(workspace, history);
    // The fields ic (_sandbox/ic/src/sandbox/preflight.rs) and the update card read by name.
    expect(Object.keys(line)).toEqual(["plan", "version", "engine", "digest", "ok", "downgrade", "failures", "steps", "converts", "files"]);
    // The contract's schema for it, which ic's reader and the staged marker share, takes it whole and adds nothing.
    expect(StatePlanSchema.strict().safeParse(line).error?.issues).toBeUndefined();
    // The pre-flight plans with exactly the registry the daemon's boot step converges with. Fresh volumes need the marks
    // the one-shot moves leave: the emptied held-wakes queue and identity rosters on the history volume, which keep a queue
    // or roster planted in the workspace later from being brought over (held-wakes-store.ts, identity-off-workspace.ts),
    // and the empty owner-wide grants file, which keeps a card-lines section written into safety.md later from being
    // promoted into grants (safety-card-lines.ts). Paths under the workspace print relative to it.
    const ownerGrants = relative(workspace, join(authRootOf({ agentAuthDir: "", workspaceRoot: workspace }), ownerGrantsDocument.path));
    expect(line).toEqual({
        plan: 1,
        version,
        engine: engineEpoch(stateDocuments(), stateSteps()),
        digest: conversionDigest(stateDocuments(), stateSteps()),
        ok: true,
        downgrade: false,
        failures: [],
        steps: [
            { document: "held-wakes-off-workspace", change: `starts ${heldWakesDocument.path} on the history volume with nothing held` },
            { document: "identity-off-workspace", change: `starts ${membersDocument.path} on the history volume with nobody on it` },
            { document: "passkeys-off-workspace", change: `starts ${passkeysDocument.path} on the history volume with no passkey in it` },
            { document: "safety-card-lines-to-owner-grants", change: `starts ${ownerGrantsDocument.path} with no line in it` },
        ],
        converts: [],
        files: [join(history, heldWakesDocument.path, ".moved-from-workspace"), join(history, membersDocument.path), join(history, passkeysDocument.path), ownerGrants],
    });
    expect(await readdir(workspace)).toEqual([]);
    expect(await readdir(history)).toEqual([]);
}, 150_000);

// Builds before the conversion digest compared counts, so a stamp holding a larger one than this registry's made every
// ordinary update read as a rollback. Which releases are downgrades is newest-run.integration.test.ts's.
test("a stamp an older build left with a larger conversion count is no downgrade", async () => {
    const { workspace, history } = await volumes();
    const stamp = join(workspace, newestRunDocument.path);
    await mkdir(dirname(stamp), { recursive: true });
    await writeFile(stamp, `${JSON.stringify({ version: "1.300.0", engine: 100_000 })}\n`);
    expect(await plan(workspace, history)).toMatchObject({ ok: true, downgrade: false });
    expect(JSON.parse(await readFile(stamp, "utf8"))).toEqual({ version: "1.300.0", engine: 100_000 });
}, 150_000);
