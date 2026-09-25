import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { packageRoot } from "@intentic/constants/node";

const run = promisify(execFile);
const ENTRY = join(packageRoot(import.meta.url), "src", "state-plan.ts");
const made: string[] = [];

afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Spawned the way the host runs it in the target image, with the test runtime standing in for node; importing the
// daemon's composition takes a few seconds on a busy runner, so the bound is generous.
test("prints one plan line naming its format, engine and verdict, and writes nothing", async () => {
    const base = await mkdtemp(join(tmpdir(), "state-plan-"));
    made.push(base);
    const workspace = join(base, "work");
    const history = join(base, "history");
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(history, { recursive: true })]);

    const { stdout } = await run(process.execPath, [ENTRY, "--workspace", workspace, "--history", history], { timeout: 120_000 });
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ plan: 1, ok: true, downgrade: false, failures: [], engine: expect.any(Number) });
    expect(await readdir(workspace)).toEqual([]);
    expect(await readdir(history)).toEqual([]);
}, 150_000);
