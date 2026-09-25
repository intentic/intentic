import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { packageRoot } from "@intentic/constants/node";
import { conversionDigest, engineEpoch } from "./store/evolution/documents.js";
import { stateDocuments, stateSteps } from "./store/evolution/state-registry.js";
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
    expect(Object.keys(line)).toEqual(["plan", "version", "engine", "digest", "ok", "downgrade", "failures", "steps", "files"]);
    // The pre-flight plans with exactly the registry the daemon's boot step converges with.
    expect(line).toEqual({
        plan: 1,
        version,
        engine: engineEpoch(stateDocuments(), stateSteps()),
        digest: conversionDigest(stateDocuments(), stateSteps()),
        ok: true,
        downgrade: false,
        failures: [],
        steps: [],
        files: [],
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
