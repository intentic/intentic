import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.js";
import { clientFor, errorCode } from "../../harness/route-client.testing.js";
import { recordingTurnStores, services } from "../../harness/route-services.testing.js";
import { runAgentTurn } from "../../harness/route-turns.testing.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { createAgentWorktrees } from "../../conversations/worktrees/worktrees.js";
import { noIsolation } from "../../conversations/worktrees/isolation.testing.js";
import { createLogger } from "../../logger.js";
import { createPerfTracker } from "../../system/resources/perf.js";

// The door a conversation started from a branch opens through (branch-start.ts): what may not be started from is refused
// before the turn exists, in plain words, and what may is checked out beside the shared tree and latched by the opening.

const git = (dir: string, ...args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

// A shared checkout on `main` with a `feature` branch and an agent's own branch beside it.
const shared = (): ReturnType<typeof workspacePaths> => {
    const root = mkdtempSync(join(tmpdir(), "branch-start-"));
    roots.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "a\n");
    git(root, "add", "a.txt");
    git(root, "commit", "-qm", "a");
    git(root, "branch", "feature");
    git(root, "branch", "agent/other");
    return workspacePaths(root);
};

const refusal = async (client: ReturnType<typeof clientFor>, fromBranch: { repo: string; branch: string }, extra: Record<string, unknown> = {}): Promise<string | undefined> =>
    errorCode(client.agent.run({ prompt: "work on it", conversationId: "from-branch", isolated: true, fromBranch, ...extra }));

test("what may not be started from is refused at the door, and nothing is checked out for it", async () => {
    const workspace = shared();
    const daemon = services({ workspace });
    const client = clientFor(createApp(daemon));
    // The repository's own main line is the shared tree itself.
    expect(await refusal(client, { repo: "root", branch: "main" })).toBe("BAD_REQUEST");
    // An agent's own copy is started from through that agent.
    expect(await refusal(client, { repo: "root", branch: "agent/other" })).toBe("BAD_REQUEST");
    // Neither here nor on origin.
    expect(await refusal(client, { repo: "root", branch: "nowhere" })).toBe("BAD_REQUEST");
    // No such repository.
    expect(await refusal(client, { repo: "libs/none", branch: "feature" })).toBe("BAD_REQUEST");
    // A runner's copy is on another machine; the land commits onto the checkout here.
    expect(await refusal(client, { repo: "root", branch: "feature" }, { placement: { kind: "runner", id: "rog" } })).toBe("BAD_REQUEST");
    // Never with another start, which the contract says before the daemon is asked.
    expect(await refusal(client, { repo: "root", branch: "feature" }, { freshOf: { conversationId: "someone", kind: "review" } })).toBe("BAD_REQUEST");
    expect(await daemon.branchCheckouts.standing()).toEqual([]);
    expect(daemon.agents.entry("from-branch")).toBeUndefined();
    expect(git(workspace.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
});

test("a branch that may be started from opens the conversation on it, and the card says so", async () => {
    const workspace = shared();
    const daemon = services({ workspace });
    const client = clientFor(createApp(daemon));
    await runAgentTurn(client, { prompt: "work on it", conversationId: "from-branch", isolated: true, fromBranch: { repo: "root", branch: "feature" } });
    expect(await daemon.branchCheckouts.standing()).toEqual([{ repo: "root", branch: "feature" }]);
    expect((await client.agents.list()).agents.find(({ id }) => id === "from-branch")?.branches).toEqual([{ repo: "root", branch: "feature" }]);
    // Started; asking an open conversation to start somewhere else is refused, the same start again is not.
    expect(await refusal(client, { repo: "root", branch: "other" })).toBe("BAD_REQUEST");
    expect(git(workspace.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
});

test("starting from a nested repository's branch starts the agent in that repository", async () => {
    const workspace = shared();
    writeFileSync(join(workspace.root, ".gitignore"), "app/\n");
    git(workspace.root, "add", ".gitignore");
    git(workspace.root, "commit", "-qm", "ignore nested repository");
    const nested = join(workspace.root, "app");
    mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    git(nested, "config", "user.email", "t@example.com");
    git(nested, "config", "user.name", "t");
    writeFileSync(join(nested, "a.txt"), "nested\n");
    git(nested, "add", "a.txt");
    git(nested, "commit", "-qm", "baseline");
    git(nested, "branch", "feature");
    const historyRoot = mkdtempSync(join(tmpdir(), "nested-branch-history-"));
    roots.push(historyRoot);
    const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
    const agentWorktrees = createAgentWorktrees({ workspace, historyRoot, worktreesRoot: join(historyRoot, "worktrees"), isolation: noIsolation(workspace.root, historyRoot), logger, perf: createPerfTracker(logger) });
    const daemon = services({ ...recordingTurnStores().overrides, workspace, agentWorktrees });
    const client = clientFor(createApp(daemon));
    const turn = await runAgentTurn(client, { prompt: "work on it", conversationId: "nested-branch", isolated: true, fromBranch: { repo: "app", branch: "feature" } });
    expect(turn.facts.filter((fact) => fact.kind === "error")).toEqual([]);
    expect(daemon.agents.get("nested-branch")?.startIn).toBe("app");
    expect(daemon.agents.get("nested-branch")?.branches).toEqual([{ repo: "app", branch: "feature" }]);
    expect(git(workspace.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git(nested, "symbolic-ref", "--short", "HEAD")).toBe("main");
});
