import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import { runnerIncomingRef } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { AgentWorktrees } from "../agents/worktrees/worktrees.js";
import type { Services } from "../composition.js";
import { createRunnerGitRefsRoute, createRunnerGitRpcRoute } from "./runner-git.routes.js";
import type { RunnerIdentity } from "./runner-identity.js";
import { pushToParent, syncFromParent } from "./runner-sync.js";

// End-to-end against a real parent: git dirs served over a live socket through the smart-HTTP doors, driven by the
// runner's sync using stock git. A wrong bearer refuses outright, and a push to the checked-out branch is refused by
// git.

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]): Promise<string> =>
    (await execFileAsync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();

const TOKEN = "irt_test-token";
let parentWork: string;
let parentHistory: string;
let runnerWork: string;
let runnerHistory: string;
let mainBranch: string;
let server: ServerType;
let identity: RunnerIdentity;

const worktreesStub = { attached: async () => false, worktreeDir: () => "" } as unknown as AgentWorktrees;
const lines: string[] = [];

beforeAll(async () => {
    parentWork = mkdtempSync(join(tmpdir(), "runner-parent-work-"));
    parentHistory = mkdtempSync(join(tmpdir(), "runner-parent-hist-"));
    runnerWork = mkdtempSync(join(tmpdir(), "runner-work-"));
    runnerHistory = mkdtempSync(join(tmpdir(), "runner-hist-"));
    await mkdir(join(parentHistory, "gits"), { recursive: true });
    await git(parentWork, ["init", "--separate-git-dir", join(parentHistory, "gits", "root")]);
    await writeFile(join(parentWork, "readme.md"), "hello from the parent\n");
    await git(parentWork, ["add", "."]);
    await git(parentWork, ["commit", "-m", "first"]);
    mainBranch = await git(parentWork, ["symbolic-ref", "--short", "HEAD"]);
    await git(parentWork, ["branch", "agent/conv1"]);

    const services = {
        config: { historyRoot: parentHistory },
        logger: { warn: () => undefined, info: () => undefined },
        runners: { verify: async (presented: string) => (presented === TOKEN ? "test-runner" : undefined) },
    } as unknown as Services;
    const app = new Hono();
    app.get("/system/runners/git/:repo/info/refs", createRunnerGitRefsRoute(services));
    app.post("/system/runners/git/:repo/git-upload-pack", createRunnerGitRpcRoute(services, "git-upload-pack"));
    app.post("/system/runners/git/:repo/git-receive-pack", createRunnerGitRpcRoute(services, "git-receive-pack"));
    server = serve({ fetch: app.fetch, port: 0 });
    const port = (server.address() as AddressInfo).port;
    identity = { parentUrl: `http://127.0.0.1:${port}`, id: "test-runner", token: TOKEN, enrolledAt: 0 };
});

afterAll(() => {
    server.close();
});

const sync = (op: "pull" | "push") => ({
    op,
    conversationId: "conv1",
    branch: "agent/conv1",
    repos: [{ repo: "root", dir: "", mainBranch }],
});

test("a wrong token is a refused door, for the advertisement already", async () => {
    const wrong = { ...identity, token: "not-it" };
    await expect(
        syncFromParent({ workspaceRoot: runnerWork, historyRoot: runnerHistory, worktrees: worktreesStub }, wrong, sync("pull"), () => undefined),
    ).rejects.toThrow();
});

test("pull materializes the mirror: main line checked out, branch landed, git dir on the history root", async () => {
    await syncFromParent({ workspaceRoot: runnerWork, historyRoot: runnerHistory, worktrees: worktreesStub }, identity, sync("pull"), (line) =>
        lines.push(line),
    );
    await expect(access(join(runnerWork, "readme.md"))).resolves.toBeUndefined();
    expect(await git(runnerWork, ["symbolic-ref", "--short", "HEAD"])).toBe(mainBranch);
    // The real git dir lives on /history; the working dir just holds a pointer to it.
    await expect(access(join(runnerHistory, "gits", "root"))).resolves.toBeUndefined();
    expect(await git(runnerWork, ["rev-parse", "agent/conv1"])).toBe(await git(parentWork, ["rev-parse", "agent/conv1"]));
    expect(lines.some((line) => line.includes("up to date"))).toBe(true);
});

test("push lands on the incoming ref, and the checked-out main branch refuses a push outright", async () => {
    await git(runnerWork, ["switch", "agent/conv1"]);
    await writeFile(join(runnerWork, "work.md"), "what the runner did\n");
    await git(runnerWork, ["add", "."]);
    await git(runnerWork, ["commit", "-m", "runner work"]);
    const tip = await git(runnerWork, ["rev-parse", "HEAD"]);
    await pushToParent({ workspaceRoot: runnerWork, historyRoot: runnerHistory, worktrees: worktreesStub }, identity, sync("push"), () => undefined);
    expect(await git(parentWork, ["rev-parse", runnerIncomingRef("conv1")])).toBe(tip);
    const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${TOKEN}` };
    await expect(
        execFileAsync("git", ["push", `${identity.parentUrl}/system/runners/git/root`, `+agent/conv1:refs/heads/${mainBranch}`], {
            cwd: runnerWork,
            env,
        }),
    ).rejects.toThrow();
});

// A local-profile parent keeps no gits/<id> on its history root; the door must ask git where the repo actually lives.
test("the door also serves a parent whose repo keeps its in-tree .git (the local profile)", async () => {
    const localWork = mkdtempSync(join(tmpdir(), "runner-local-work-"));
    const localHistory = mkdtempSync(join(tmpdir(), "runner-local-hist-"));
    await git(localWork, ["init", "-q"]);
    await writeFile(join(localWork, "local.md"), "a repo the user owns\n");
    await git(localWork, ["add", "."]);
    await git(localWork, ["commit", "-m", "local"]);

    const services = {
        config: { historyRoot: localHistory },
        workspace: { root: localWork },
        logger: { warn: () => undefined, info: () => undefined },
        runners: { verify: async (presented: string) => (presented === TOKEN ? "test-runner" : undefined) },
    } as unknown as Services;
    const app = new Hono();
    app.get("/system/runners/git/:repo/info/refs", createRunnerGitRefsRoute(services));
    app.post("/system/runners/git/:repo/git-upload-pack", createRunnerGitRpcRoute(services, "git-upload-pack"));
    const local = serve({ fetch: app.fetch, port: 0 });
    try {
        const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
        const response = await fetch(`${url}/system/runners/git/root/info/refs?service=git-upload-pack`, {
            headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("service=git-upload-pack");
        // A repo id that climbs out of the workspace (`../../etc`) is nobody's repository.
        const escaped = await fetch(`${url}/system/runners/git/${encodeURIComponent("../../etc")}/info/refs?service=git-upload-pack`, {
            headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(escaped.status).toBe(404);
    } finally {
        local.close();
    }
});

test("a second pull is incremental and reconciles the branch onto what the parent has", async () => {
    await writeFile(join(parentWork, "second.md"), "the parent moved\n");
    await git(parentWork, ["add", "."]);
    await git(parentWork, ["commit", "-m", "second"]);
    // The runner's checkout sits back on the main branch between turns, as the real flow leaves it.
    await git(runnerWork, ["switch", mainBranch]);
    await syncFromParent({ workspaceRoot: runnerWork, historyRoot: runnerHistory, worktrees: worktreesStub }, identity, sync("pull"), () => undefined);
    expect(await git(runnerWork, ["rev-parse", mainBranch])).toBe(await git(parentWork, ["rev-parse", mainBranch]));
    await expect(access(join(runnerWork, "second.md"))).resolves.toBeUndefined();
});
