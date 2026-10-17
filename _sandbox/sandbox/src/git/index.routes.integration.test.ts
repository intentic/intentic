import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { INDEX_RUN_FILE_LIMIT, type IndexRun } from "@intentic/sandbox-contract/schemas/git/index-run";
import { unstubbed } from "@intentic/testing";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { createApp } from "../app.js";
import type { CompositionCore } from "../composition.js";
import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import { workspacePaths } from "../workspace/workspace.js";
import { gitSlice } from "./git-slice.js";

// The stage and commit runs over real git, driven over the daemon's HTTP surface as the Changes panel drives them: the
// guardrail on a tree past its line, dependency dirs left out, a commit's answer, and a cancel that kills a hung commit.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
// The slice builds over nothing of the core; a stub that throws on any read says so.
const realGit = gitSlice.build(unstubbed<CompositionCore>("core", {})).git;

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace holding one committed project repo, `app`.
const workspace = async (): Promise<{ readonly root: string; readonly app: string }> => {
    const root = await mkdtemp(join(tmpdir(), "intentic-index-run-"));
    tempDirs.push(root);
    const app = join(root, "app");
    await mkdir(app);
    await sh(app, "init", "-q", "--initial-branch=main");
    await sh(app, "config", "user.name", "t");
    await sh(app, "config", "user.email", "t@t");
    await writeFile(join(app, "README.md"), "# app\n");
    await sh(app, "add", "-A");
    await sh(app, "commit", "-q", "-m", "base");
    return { root, app };
};

const clientOn = (root: string) => clientFor(createApp(services({ workspace: workspacePaths(root), git: realGit })));

type Client = ReturnType<typeof clientOn>;

const settled = (client: Client, repo: string): Promise<IndexRun> =>
    waitFor(async () => {
        const run = await client.git.indexRunState({ repo });
        if (run.status === "running") {
            throw new Error(`still ${run.phase ?? "running"}`);
        }
        return run;
    }, SETTLES);

const stagedNames = async (app: string): Promise<readonly string[]> => (await sh(app, "diff", "--cached", "--name-only")).split("\n").filter(Boolean);

test("a stage-all past the guardrail holds before touching the index, names the dirs, and stages once confirmed, never a dependency dir", async () => {
    const { root, app } = await workspace();
    const generated = INDEX_RUN_FILE_LIMIT + 50;
    await mkdir(join(app, "gen"));
    await Promise.all(Array.from({ length: generated }, (_, index) => writeFile(join(app, "gen", `f${String(index)}.txt`), `${String(index)}\n`)));
    await writeFile(join(app, "main.py"), "print('hi')\n");
    // Dependency trees at the top and nested: the project excludes keep both out of what a stage-all counts or takes.
    await mkdir(join(app, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(app, "node_modules", "pkg", "index.js"), "\n");
    await mkdir(join(app, "tools", "venv", "lib"), { recursive: true });
    await writeFile(join(app, "tools", "venv", "lib", "site.py"), "\n");
    const client = clientOn(root);

    const started = await client.git.indexRunStart({ repo: "app", op: "stage" });
    expect(started).toMatchObject({ status: "running", op: "stage" });
    const held = await settled(client, "app");
    expect(held.status).toBe("error");
    expect(held.held).toMatchObject({ files: generated + 1, dirs: [{ dir: "gen", files: generated }, { dir: "", files: 1 }] });
    expect(await stagedNames(app)).toEqual([]);

    await client.git.indexRunStart({ repo: "app", op: "stage", confirmed: true });
    expect(await settled(client, "app")).toMatchObject({ status: "passed", files: { total: generated + 1, done: generated + 1 } });
    const staged = await stagedNames(app);
    expect(staged).toHaveLength(generated + 1);
    expect(staged.filter((path) => path.includes("node_modules") || path.includes("venv"))).toEqual([]);
});

test("a commit run stages its target, commits, and settles with the commit route's own answer", async () => {
    const { root, app } = await workspace();
    await writeFile(join(app, "a.ts"), "export const a = 1;\n");
    const client = clientOn(root);
    await client.git.indexRunStart({ repo: "app", op: "commit", target: {}, message: "feat: a" });
    const run = await settled(client, "app");
    expect(run).toMatchObject({ status: "passed", op: "commit", result: { committed: true } });
    // Nothing left to show: the answer drops the row, as the commit route's does.
    expect(run.result?.changes).toBeUndefined();
    expect(await sh(app, "log", "-1", "--format=%s")).toBe("feat: a");
    expect(await errorCode(client.git.indexRunStart({ repo: "nope", op: "stage" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.git.indexRunStart({ repo: "app", op: "stage", message: "x" }))).toBe("BAD_REQUEST");
});

test("while a commit hangs in its hook, the same start joins it, a stage is refused, and cancel kills it with nothing recorded", async () => {
    const { root, app } = await workspace();
    await writeFile(join(app, "a.ts"), "export const a = 1;\n");
    const hook = join(app, ".git", "hooks", "pre-commit");
    await mkdir(join(app, ".git", "hooks"), { recursive: true });
    // `exec` so the hook is the process git waits on; killing git leaves it to finish on its own, harmlessly.
    await writeFile(hook, "#!/bin/sh\nexec sleep 3\n");
    await chmod(hook, 0o755);
    const head = await sh(app, "rev-parse", "HEAD");
    const client = clientOn(root);

    const first = await client.git.indexRunStart({ repo: "app", op: "commit", target: {}, message: "feat: hung" });
    await waitFor(async () => expect((await client.git.indexRunState({ repo: "app" })).phase).toBe("committing"), SETTLES);
    expect((await client.git.indexRunStart({ repo: "app", op: "commit", target: {}, message: "feat: hung" })).id).toBe(first.id);
    expect(await errorCode(client.git.indexRunStart({ repo: "app", op: "stage" }))).toBe("CONFLICT");
    // The Changes response says the repo is committing, as it does for the one-request commit.
    expect((await client.git.changes()).committing).toEqual(["app"]);

    const from = Date.now();
    await client.git.indexRunCancel({ repo: "app" });
    expect(await settled(client, "app")).toMatchObject({ status: "cancelled", id: first.id });
    expect(Date.now() - from).toBeLessThan(2_500);
    expect(await sh(app, "rev-parse", "HEAD")).toBe(head);
});
