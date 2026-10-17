// Large path sets must remain ordinary land outcomes, including when the owner has a new uncommitted tree.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { GitRunner } from "@intentic/base/git";
import { defaultGit } from "@intentic/base/git";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import { noIsolation } from "../../worktrees/isolation.testing.js";
import { ensureRootRepo } from "../../../git/remote/root-repo.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { landAgent } from "../land.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../../worktrees/worktrees.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);
// Shared directories keep the file count modest while the path argv still exceeds Linux ARG_MAX.
const COUNT = 3_100;
const pathOf = (i: number): string => `${"long-directory-name-".repeat(10)}/${"nested-".repeat(30)}/${"deep-".repeat(40)}/${"extra-".repeat(20)}/file-${String(i).padStart(5, "0")}.json`;
const boundedGit: GitRunner = (dir, args, env) => {
    // Assert the boundary even on hosts whose ARG_MAX is larger than Linux's usual 2 MiB.
    expect(args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 9, 0)).toBeLessThan(200_000);
    return defaultGit(dir, args, env);
};

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const writeMany = async (root: string, count: number, body: (i: number) => string): Promise<void> => {
    const dirs = new Set(Array.from({ length: count }, (_, i) => dirname(join(root, pathOf(i)))));
    for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
    }
    for (let i = 0; i < count; i += 500) {
        await Promise.all(Array.from({ length: Math.min(500, count - i) }, async (_, k) => writeFile(join(root, pathOf(i + k)), body(i + k))));
    }
};

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-repro-land-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), "line one\nline two\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    const conversation = await worktrees.ensure("c1", []);
    return { work, worktrees, conversation };
};

test("a large owner overlap is a workspace conflict with its count, without per-file probes", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeMany(work, COUNT, (i) => `owner ${i}\n`);
    await writeMany(conversation.cwd, COUNT, (i) => `agent ${i}\n`);
    await writeFile(join(conversation.cwd, "app.ts"), "agent edit\n");
    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "check", "outstanding", undefined, boundedGit);
    expect(result.landed).toBe(false);
    expect(result.conflicts?.[0]?.paths).toEqual(Array.from({ length: COUNT }, (_, i) => ({ path: pathOf(i), reason: "workspace" as const })).sort((a, b) => a.path.localeCompare(b.path)));
    expect(result.conflicts?.[0]?.clean).toBe(1);
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one\nline two\n");
    expect(await readFile(join(work, pathOf(0)), "utf8")).toBe("owner 0\n");
});

test("one already-present file leaves a remainder past ARG_MAX that lands in bounded chunks", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeMany(conversation.cwd, COUNT, (i) => `agent ${i}\n`);
    await writeFile(join(conversation.cwd, "notes.md"), "same\n");
    await writeFile(join(work, "notes.md"), "same\n");
    await rename(join(conversation.cwd, "app.ts"), join(conversation.cwd, pathOf(COUNT)));
    expect(Array.from({ length: COUNT }, (_, i) => pathOf(i)).join("\0").length).toBeGreaterThan(2_097_152);
    const pairedGit: GitRunner = (dir, args, env) => {
        const paths = new Set(args.slice(args.indexOf("--") + 1));
        if (args[0] === "diff" && args.includes("--") && (paths.has("app.ts") || paths.has(pathOf(COUNT)))) {
            expect(paths.has("app.ts") && paths.has(pathOf(COUNT))).toBe(true);
        }
        return boundedGit(dir, args, env);
    };
    const result = await landAgent(worktrees, isolatedAgent(conversation.repos), "check", "outstanding", undefined, pairedGit);
    expect(result.landed).toBe(true);
    expect(result.conflicts).toBeUndefined();
    expect(result.diff.files).toBe(COUNT + 2);
    expect(await readFile(join(work, pathOf(COUNT)), "utf8")).toBe("line one\nline two\n");
    expect(await readFile(join(work, pathOf(0)), "utf8")).toBe("agent 0\n");
    expect(await readFile(join(work, pathOf(COUNT - 1)), "utf8")).toBe(`agent ${COUNT - 1}\n`);
});
