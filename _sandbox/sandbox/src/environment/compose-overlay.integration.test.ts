import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { packageRoot } from "@intentic/constants/node";
import { statePath } from "../state-paths.js";

const run = promisify(execFile);
const ENTRY = join(packageRoot(import.meta.url), "src", "environment", "compose-overlay.ts");
const made: string[] = [];

afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// `ic` runs the target image's composer over read-only mounts of the running sandbox's volumes, whose history already
// holds the daemon's logs/ directory (composition.rs). Opening a log there for writing failed after composing had
// returned, as an 'error' event no try/catch sees: the process exited 1, and every compose read as failed (2026-10-21).
// A directory where each log file would be fails the same open on any machine, without a read-only mount.
test("the composer opens no log file for writing, and answers with its line where none can be opened", async () => {
    const base = await mkdtemp(join(tmpdir(), "compose-overlay-"));
    made.push(base);
    const [workspace, history, auth] = [join(base, "work"), join(base, "history"), join(base, "auth")];
    const logs = join(history, "logs");
    await Promise.all([workspace, join(logs, "perf.jsonl"), join(logs, "client.jsonl"), auth].map((dir) => mkdir(dir, { recursive: true })));
    // An empty sandbox may need no overlay at all. Give this one an approved input so composing exercises the output
    // path regardless of the host image's baked packs or runner-set environment.
    const custom = statePath(workspace, ".intentic/config/environment.custom.Dockerfile");
    await mkdir(dirname(custom), { recursive: true });
    await writeFile(custom, "RUN echo log-free-composition\n");

    // Spawned the way ic runs it in the target image, with the test runtime standing in for node; the bound is a hang
    // bound for a busy runner.
    const { stdout } = await run(process.execPath, ["--conditions=@intentic/src", ENTRY, "--base", "ghcr.io/intentic/sandbox:stable"], {
        env: { ...process.env, WORKSPACE_ROOT: workspace, HISTORY_ROOT: history, AGENT_AUTH_DIR: auth },
        timeout: 120_000,
    });

    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(
        expect.objectContaining({ compose: 1, overlay: expect.stringContaining("FROM ghcr.io/intentic/sandbox:stable") }),
    );
});
