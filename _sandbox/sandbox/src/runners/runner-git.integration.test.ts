import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve, type ServerType } from "@hono/node-server";
import { STATE_DIR } from "@intentic/constants";
import { runnerIncomingRef, type RunnerSyncWork } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { Hono } from "hono";
import type { AgentWorktrees } from "../conversations/worktrees/worktrees.js";
import type { Services } from "../composition.js";
import { createRunnerGitRefsRoute, createRunnerGitRpcRoute } from "./runner-git.routes.js";
import type { RunnerIdentity } from "./runner-identity.js";
import { pushToParent, syncFromParent } from "./runner-sync.js";
import { syncHeld } from "./runner-service.js";

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
        runners: { verify: async (presented: string) => (presented === TOKEN ? { kind: "enrolled", id: "test-runner" } : { kind: "unknown" }) },
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
    expect(existsSync(join(runnerWork, "readme.md"))).toBe(true);
    expect(await git(runnerWork, ["symbolic-ref", "--short", "HEAD"])).toBe(mainBranch);
    // The real git dir lives on /history; the working dir just holds a pointer to it.
    expect(existsSync(join(runnerHistory, "gits", "root"))).toBe(true);
    expect(await git(runnerWork, ["rev-parse", "agent/conv1"])).toBe(await git(parentWork, ["rev-parse", "agent/conv1"]));
    expect(lines.some((line) => line.includes("up to date"))).toBe(true);
});

const freshRunner = (): { workspaceRoot: string; historyRoot: string; worktrees: AgentWorktrees } => ({
    workspaceRoot: mkdtempSync(join(tmpdir(), "runner-work-")),
    historyRoot: mkdtempSync(join(tmpdir(), "runner-hist-")),
    worktrees: worktreesStub,
});

test("a conversation branch the parent has not created yet starts at main", async () => {
    const said: string[] = [];
    await syncFromParent(freshRunner(), identity, { ...sync("pull"), branch: "agent/not-yet" }, (line) => said.push(line));
    expect(said).toContain(`root: the parent has no agent/not-yet yet, starting it at ${mainBranch}`);
});

// The parent hard-resets the conversation onto what a runner pushes back, so a runner that silently started from main
// would hand back a branch without the conversation's earlier turns.
test("a conversation branch that failed to fetch for any other reason fails the sync instead of starting at main", async () => {
    const said: string[] = [];
    await expect(syncFromParent(freshRunner(), identity, { ...sync("pull"), branch: "agent/not a ref" }, (line) => said.push(line))).rejects.toThrow(
        "invalid refspec",
    );
    expect(said.some((line) => line.includes("starting it at"))).toBe(false);
});

// A fan-out dispatches several conversations to one runner at once; each pull must still get through.
test("concurrent pulls into one mirror all succeed", async () => {
    const runner = freshRunner();
    await git(parentWork, ["branch", "-f", "agent/conv2", mainBranch]);
    await git(parentWork, ["branch", "-f", "agent/conv3", mainBranch]);
    const pulls = ["agent/conv1", "agent/conv2", "agent/conv3"].map((branch) =>
        syncFromParent(runner, identity, { ...sync("pull"), branch }, () => undefined),
    );
    await expect(Promise.all(pulls)).resolves.toBeDefined();
    for (const branch of ["agent/conv1", "agent/conv2", "agent/conv3"]) {
        expect(await git(runner.workspaceRoot, ["rev-parse", branch])).toBe(await git(parentWork, ["rev-parse", branch]));
    }
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
        runners: { verify: async (presented: string) => (presented === TOKEN ? { kind: "enrolled", id: "test-runner" } : { kind: "unknown" }) },
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
    await syncFromParent(
        { workspaceRoot: runnerWork, historyRoot: runnerHistory, worktrees: worktreesStub },
        identity,
        sync("pull"),
        () => undefined,
    );
    expect(await git(runnerWork, ["rev-parse", mainBranch])).toBe(await git(parentWork, ["rev-parse", mainBranch]));
    expect(existsSync(join(runnerWork, "second.md"))).toBe(true);
});

// A runner with conversation `id`'s branch pulled and checked out in a worktree of its own, as a turn there leaves it.
const checkedOut = async (id: string, title?: string) => {
    await git(parentWork, ["branch", "-f", `agent/${id}`, mainBranch]);
    const runner = freshRunner();
    const pull = { ...sync("pull"), conversationId: id, branch: `agent/${id}` };
    await syncFromParent(runner, identity, pull, () => undefined);
    const checkout = join(mkdtempSync(join(tmpdir(), "runner-checkout-")), id);
    await git(runner.workspaceRoot, ["worktree", "add", checkout, `agent/${id}`]);
    const attached = { ...runner, worktrees: { attached: async () => true, worktreeDir: () => checkout }, titleOf: () => title };
    const said: { line: string; work?: RunnerSyncWork }[] = [];
    const say = (line: string, work?: RunnerSyncWork): void => void said.push(work === undefined ? { line } : { line, work });
    return { runner: attached, checkout, pull, push: { ...pull, op: "push" as const }, said, say };
};

// The parent moves a conversation's branch while it waits (as its rebase onto a newer main line does): one commit on top.
const parentMoves = async (id: string, path: string, text: string): Promise<string> => {
    const scratch = mkdtempSync(join(tmpdir(), "parent-move-"));
    await git(parentWork, ["worktree", "add", scratch, `agent/${id}`]);
    await writeFile(join(scratch, path), text);
    await git(scratch, ["add", "."]);
    await git(scratch, ["commit", "-m", `the parent moved ${path}`]);
    const tip = await git(scratch, ["rev-parse", "HEAD"]);
    await git(parentWork, ["worktree", "remove", "--force", scratch]);
    return tip;
};

// 2026-11-04: a pull for a new turn hard-reset a checkout whose previous turn was still working in it on the runner. And
// 2026-11-24: the rescue ref that replaced the reset kept the work on the runner only, and the resumed turn went on
// without it (ginger-v2nz, twice). A pull now commits such work and carries it into the turn.
test("a pull carries work the parent never received into the checkout instead of resetting it away", async () => {
    const { runner, checkout, pull, said, say } = await checkedOut("conv6", "Fix the readme");
    await writeFile(join(checkout, "unpushed.md"), "never pushed\n");
    await git(checkout, ["add", "."]);
    await git(checkout, ["commit", "-m", "unpushed"]);
    const unpushed = await git(checkout, ["rev-parse", "HEAD"]);
    await writeFile(join(checkout, "readme.md"), "edited, never committed\n");

    await syncFromParent(runner, identity, pull, say);

    expect(await readFile(join(checkout, "readme.md"), "utf8")).toBe("edited, never committed\n");
    expect(existsSync(join(checkout, "unpushed.md"))).toBe(true);
    expect(await git(checkout, ["status", "--porcelain"])).toBe("");
    expect(await git(checkout, ["merge-base", "--is-ancestor", unpushed, "HEAD"]).then(() => true, () => false)).toBe(true);
    expect(said.map((entry) => entry.work?.kind).filter((kind) => kind !== undefined)).toEqual(["carried"]);
    expect(said.find((entry) => entry.work !== undefined)?.work?.files).toBe(2);
    expect(await git(runner.workspaceRoot, ["for-each-ref", "refs/runner-rescue/"])).toBe("");
});

// ginger-v2nz's exact shape: edits to tracked files left uncommitted by a failed turn, and the parent's branch rebased
// onto a newer main line while the conversation waited. The edits are replayed onto the parent's branch.
test("a pull replays the work the parent never received onto a branch the parent moved while it waited", async () => {
    const { runner, checkout, pull, said, say } = await checkedOut("conv7");
    await writeFile(join(checkout, "readme.md"), "a failed turn's edit\n");
    const moved = await parentMoves("conv7", "other.md", "main moved on\n");

    await syncFromParent(runner, identity, pull, say);

    expect(await readFile(join(checkout, "readme.md"), "utf8")).toBe("a failed turn's edit\n");
    expect(await readFile(join(checkout, "other.md"), "utf8")).toBe("main moved on\n");
    expect(await git(checkout, ["merge-base", "--is-ancestor", moved, "HEAD"]).then(() => true, () => false)).toBe(true);
    const carried = said.find((entry) => entry.work !== undefined)?.work;
    expect(carried?.kind).toBe("carried");
    expect(carried?.sha).toBe(await git(checkout, ["rev-parse", "HEAD"]));
});

test("work that does not replay onto the parent's moved branch stays in the checkout, and the next push brings it home", async () => {
    const { runner, checkout, pull, push, said, say } = await checkedOut("conv8");
    await writeFile(join(checkout, "readme.md"), "the runner's edit\n");
    const moved = await parentMoves("conv8", "readme.md", "the parent's own edit\n");

    await syncFromParent(runner, identity, pull, say);

    expect(await readFile(join(checkout, "readme.md"), "utf8")).toBe("the runner's edit\n");
    expect(await git(checkout, ["status", "--porcelain"])).toBe("");
    const kept = said.find((entry) => entry.work !== undefined)?.work;
    expect(kept).toMatchObject({ kind: "kept", parentTip: moved, files: 1 });
    await pushToParent(runner, identity, push, () => undefined);
    expect(await git(parentWork, ["show", `${runnerIncomingRef("conv8")}:readme.md`])).toBe("the runner's edit");
});

// What a build before `sync-keeps-work` set aside on the runner stayed there: ginger-v2nz's two snapshots, sage-xrd4's and
// sub-honey-w8qw's were found by hand on omen's disk. The next sync sends each home under the same name and drops it there.
test("a snapshot an earlier build set aside is sent home, said with what it holds, and dropped from the runner", async () => {
    const { runner, checkout, pull, said, say } = await checkedOut("conv9");
    await writeFile(join(checkout, "readme.md"), "set aside by an older build\n");
    const snapshot = await git(checkout, ["stash", "create", "undelivered work of conv9"]);
    await git(checkout, ["checkout", "--", "readme.md"]);
    const ref = "refs/runner-rescue/conv9/1795555026774";
    await git(runner.workspaceRoot, ["update-ref", ref, snapshot]);

    await syncFromParent(runner, identity, pull, say);

    expect(await git(parentWork, ["rev-parse", ref])).toBe(snapshot);
    expect(await git(runner.workspaceRoot, ["for-each-ref", "refs/runner-rescue/conv9/"])).toBe("");
    const rescue = said.find((entry) => entry.work?.kind === "rescue")?.work;
    expect(rescue).toMatchObject({ kind: "rescue", repo: "root", sha: snapshot, files: 1, ref, at: 1795555026774 });
    expect(await git(parentWork, ["show", `${rescue?.base}:readme.md`])).toBe("hello from the parent");
});

test("a push of a branch the parent already has makes no push", async () => {
    const { runner, push, said, say } = await checkedOut("conv10");
    await pushToParent(runner, identity, push, say);
    expect(said.filter((entry) => entry.line.includes("pushing"))).toEqual([]);
    await expect(git(parentWork, ["rev-parse", runnerIncomingRef("conv10")])).rejects.toThrow();
});

// 2026-11-23: a failed or stopped turn never reaches the land that commits a checkout's leftovers, so its push carried
// the branch's tip alone, and the next pull moved its edits to a rescue ref on the runner. The push commits them first.
test("a push commits what the turn left uncommitted in its checkout before delivering the branch", async () => {
    await git(parentWork, ["branch", "-f", "agent/conv4", mainBranch]);
    const runner = freshRunner();
    const conv4 = { ...sync("pull"), conversationId: "conv4", branch: "agent/conv4" };
    await syncFromParent(runner, identity, conv4, () => undefined);
    const checkout = join(mkdtempSync(join(tmpdir(), "runner-checkout-")), "conv4");
    await git(runner.workspaceRoot, ["worktree", "add", checkout, "agent/conv4"]);
    const attached = { ...runner, worktrees: { attached: async () => true, worktreeDir: () => checkout }, titleOf: () => "Fix the readme" };
    await writeFile(join(checkout, "readme.md"), "edited by a turn that failed\n");
    await writeFile(join(checkout, "new.md"), "untracked\n");

    await pushToParent(attached, identity, { ...conv4, op: "push" }, () => undefined);

    const delivered = runnerIncomingRef("conv4");
    expect(await git(parentWork, ["show", `${delivered}:readme.md`])).toBe("edited by a turn that failed");
    expect(await git(parentWork, ["show", `${delivered}:new.md`])).toBe("untracked");
    expect(await git(parentWork, ["log", "-1", "--format=%s", delivered])).toBe("Agent: Fix the readme");
    expect(await git(checkout, ["status", "--porcelain"])).toBe("");
});

// Review, 2026-11-23: a push while the runner's turn is still running (the parent stopped following it, or its link
// dropped) must not commit the checkout mid-write: the branch's tip goes alone, and the edits stay where they are.
test("a push while the runner's turn still runs delivers the branch's tip alone and leaves the checkout as it is", async () => {
    await git(parentWork, ["branch", "-f", "agent/conv5", mainBranch]);
    const runner = freshRunner();
    const conv5 = { ...sync("pull"), conversationId: "conv5", branch: "agent/conv5" };
    await syncFromParent(runner, identity, conv5, () => undefined);
    const checkout = join(mkdtempSync(join(tmpdir(), "runner-checkout-")), "conv5");
    await git(runner.workspaceRoot, ["worktree", "add", checkout, "agent/conv5"]);
    const attached = { ...runner, worktrees: { attached: async () => true, worktreeDir: () => checkout } };
    await writeFile(join(checkout, "done.md"), "committed by the turn\n");
    await git(checkout, ["add", "."]);
    await git(checkout, ["commit", "-m", "the turn's commit"]);
    await writeFile(join(checkout, "readme.md"), "half written\n");
    const tip = await git(checkout, ["rev-parse", "HEAD"]);
    const live = { held: () => ({ state: "live" as const, events: 1, acked: 0 }), settle: async () => undefined, delivered: () => undefined };

    for await (const line of syncHeld(live, attached, identity, { ...conv5, op: "push" })) {
        void line;
    }

    expect(await git(parentWork, ["rev-parse", runnerIncomingRef("conv5")])).toBe(tip);
    expect(await git(checkout, ["status", "--porcelain"])).toBe("M readme.md");
});

// The shinobi-society audit (2026-11-17): every runner placement failed with "Your local changes ... would be overwritten
// by checkout: .intentic/config/capabilities.json", the runner's own daemon having written its definition into the
// mirror. The pull now keeps such edits and goes on: the runner's own definition files stay as the runner wrote them,
// and anything else edited there is kept under a rescue ref rather than lost.
test("a pull survives uncommitted edits in the mirror, keeping the runner's own definition files and rescuing the rest", async () => {
    const capabilities = join(STATE_DIR, "config", "capabilities.json");
    await mkdir(join(parentWork, STATE_DIR, "config"), { recursive: true });
    await writeFile(join(parentWork, capabilities), '{"from":"parent-1"}\n');
    await git(parentWork, ["add", "."]);
    await git(parentWork, ["commit", "-m", "capabilities"]);
    const runner = freshRunner();
    await syncFromParent(runner, identity, sync("pull"), () => undefined);

    await writeFile(join(runner.workspaceRoot, capabilities), '{"from":"runner"}\n');
    await writeFile(join(runner.workspaceRoot, "readme.md"), "a person's edit on the runner\n");
    await writeFile(join(parentWork, capabilities), '{"from":"parent-2"}\n');
    await writeFile(join(parentWork, "readme.md"), "the parent's readme, moved on\n");
    await git(parentWork, ["commit", "-am", "both moved"]);

    const said: string[] = [];
    await syncFromParent(runner, identity, sync("pull"), (line) => void said.push(line));
    expect(await git(runner.workspaceRoot, ["rev-parse", "HEAD"])).toBe(await git(parentWork, ["rev-parse", mainBranch]));
    expect(await readFile(join(runner.workspaceRoot, capabilities), "utf8")).toBe('{"from":"runner"}\n');
    expect(await readFile(join(runner.workspaceRoot, "readme.md"), "utf8")).toBe("the parent's readme, moved on\n");
    expect(said.filter((line) => line.includes("kept uncommitted edits"))).toHaveLength(1);
    const kept = await git(runner.workspaceRoot, ["for-each-ref", "--format=%(objectname)", "refs/runner-rescue/main-line/"]);
    expect(await git(runner.workspaceRoot, ["show", `${kept}:readme.md`])).toBe("a person's edit on the runner");

    // The runner's own files alone are put back as they were and keep nothing: it rewrites them on every pull, and each
    // made a rescue ref and a line before (2026-11-24).
    await writeFile(join(runner.workspaceRoot, capabilities), '{"from":"runner, again"}\n');
    const own: string[] = [];
    await syncFromParent(runner, identity, sync("pull"), (line) => void own.push(line));
    expect(own.filter((line) => line.includes("kept uncommitted edits"))).toEqual([]);
    expect(await readFile(join(runner.workspaceRoot, capabilities), "utf8")).toBe('{"from":"runner, again"}\n');

    // A clean mirror keeps nothing.
    await git(runner.workspaceRoot, ["checkout", "--", capabilities]);
    const again: string[] = [];
    await syncFromParent(runner, identity, sync("pull"), (line) => void again.push(line));
    expect(again.filter((line) => line.includes("kept uncommitted edits"))).toEqual([]);
});

// The same audit's first placements: the runner's daemon writes its definition into /work before the mirror's first
// pull, when the mirror tracks nothing yet, and the checkout refused with "untracked working tree files would be
// overwritten". The pull keeps the runner's own files as it wrote them and goes on.
test("a first pull into a mirror the runner's daemon already wrote its definition into goes on, keeping the runner's files", async () => {
    const capabilities = join(STATE_DIR, "config", "capabilities.json");
    expect(await git(parentWork, ["ls-files", "--", capabilities])).toBe(capabilities);
    const runner = freshRunner();
    await mkdir(join(runner.workspaceRoot, STATE_DIR, "config"), { recursive: true });
    await writeFile(join(runner.workspaceRoot, capabilities), '{"from":"runner, before any pull"}\n');

    await syncFromParent(runner, identity, sync("pull"), () => undefined);

    expect(await git(runner.workspaceRoot, ["rev-parse", "HEAD"])).toBe(await git(parentWork, ["rev-parse", mainBranch]));
    expect(await readFile(join(runner.workspaceRoot, capabilities), "utf8")).toBe('{"from":"runner, before any pull"}\n');
    // Tracked from here on, so the next pull keeps it the way it keeps any edit of the runner's own files.
    await syncFromParent(runner, identity, sync("pull"), () => undefined);
    expect(await readFile(join(runner.workspaceRoot, capabilities), "utf8")).toBe('{"from":"runner, before any pull"}\n');
});
