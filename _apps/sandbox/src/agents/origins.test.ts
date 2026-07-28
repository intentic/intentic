import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { ensureRootRepo } from "../git/root-repo.js";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import type { AgentsRegistry } from "./agents-registry.js";
import type { PersistedAgent } from "./agents-store.js";
import { landAgent } from "./land.js";
import { createAgentOrigins } from "./origins.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "./worktrees.js";

/* Attribution is derived from the landed shas, so these run against a REAL land into a real main tree — the
 * only way to prove the derivation matches what the patch actually did. The registry is stubbed down to the
 * two methods origins reads (ids/entry); everything else on it is irrelevant here. */

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

// The baseline file with one line rewritten — the two agents take far-apart lines of it.
const LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
const edited = (line: number): string => `${LINES.map((text, index) => (index === line - 1 ? `${text} EDITED` : text)).join("\n")}\n`;

// No mount namespace here: these suites assert the SYMLINK mirroring, which is what a container without
// CAP_SYS_ADMIN (and every test runner) actually gets. The bind-mount branch is isolation.test.ts's.
const noIsolation = { available: async () => false, planFor: async () => undefined };

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-origins-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    // Long enough that two agents can edit far-apart regions of it and both patches still apply.
    await writeFile(join(work, "app.ts"), `${LINES.join("\n")}\n`);
    await writeFile(join(work, "other.ts"), "untouched\n");
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "baseline");
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), isolation: noIsolation, logger });
    return { work, worktrees, conversation: await worktrees.ensure("c1", []) };
};

const entryFor = (repos: PersistedAgent["repos"], id = "c1"): PersistedAgent => ({
    id,
    branch: `agent/${id}`,
    title: "fix the thing",
    provider: "claude",
    harness: "native",
    repos: [...repos],
    status: "idle",
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    createdAt: 0,
    updatedAt: 0,
});

// Only ids() and entry() are read; the rest of the registry surface never runs.
const registryOf = (...entries: PersistedAgent[]): AgentsRegistry =>
    ({
        ids: () => entries.map((entry) => entry.id),
        entry: (id: string) => entries.find((entry) => entry.id === id),
    }) as unknown as AgentsRegistry;

test("a landed file is credited to the agent that landed it; untouched files are unattributed", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    await writeFile(join(conversation.cwd, "added.ts"), "new file\n");
    const landed = await landAgent(worktrees, entryFor(conversation.repos));

    const origins = createAgentOrigins({ agents: registryOf(entryFor(landed.repos)), logger });
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"], "added.ts": ["c1"] });
});

test("nothing landed ⇒ nothing claimed", async () => {
    const { work, worktrees, conversation } = await setup();
    const origins = createAgentOrigins({ agents: registryOf(entryFor(conversation.repos)), logger });
    expect(await origins.forRepo("root", work)).toEqual({});
    // Same for a repo the agent's composition doesn't even include.
    await worktrees.remove("c1", conversation.repos);
    expect(await origins.forRepo("nested", work)).toEqual({});
});

test("a path two agents landed lists both, newest land first", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, entryFor(conversation.repos));

    const second = await worktrees.ensure("c2", []);
    // The LAST line, far from c1's hunk: land is context-based, so a second agent's patch applies cleanly
    // over work already sitting in the tree as long as the hunks don't overlap — which is exactly how one
    // uncommitted file ends up owned by two agents at once.
    await writeFile(join(second.cwd, "app.ts"), edited(12));
    const later = await landAgent(worktrees, entryFor(second.repos, "c2"));

    // c2 landed after c1 — both own the path, and the most recent author reads first.
    const agents = registryOf(entryFor(first.repos), entryFor(later.repos, "c2"));
    expect((await createAgentOrigins({ agents, logger }).forRepo("root", work))[`app.ts`]).toEqual(["c2", "c1"]);
});

test("committing one agent's work leaves another agent's landed files attributed", async () => {
    const { work, worktrees, conversation } = await setup();
    // c1 lands app.ts, c2 lands other.ts — two agents waiting in the same tree, which is the normal board.
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const first = await landAgent(worktrees, entryFor(conversation.repos));
    const second = await worktrees.ensure("c2", []);
    await writeFile(join(second.cwd, "other.ts"), "c2 was here\n");
    const later = await landAgent(worktrees, entryFor(second.repos, "c2"));

    // The user reviews c2 and commits ONLY other.ts. HEAD moves, but nothing has happened to app.ts…
    await sh(work, "add", "other.ts");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed c2");

    // …so c1 keeps its file and c2's — now in history — drops out. A repo-wide expiry would blank both.
    const origins = createAgentOrigins({ agents: registryOf(entryFor(first.repos), entryFor(later.repos, "c2")), logger });
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });
});

test("identify names an ARCHIVED agent — the roster the client mirrors no longer carries it", async () => {
    // The whole reason identity rides the response: archiving a finished agent takes it off the fleet roster
    // (AgentsRegistry.list drops archived entries) but does NOT commit its landed lines, so the panel is
    // reviewing work whose author the client can no longer look up. Reading `entry` covers both halves.
    const archived = { ...entryFor([], "c1"), archivedAt: 1 };
    const untitled = { ...entryFor([], "c2") };
    delete untitled.title;
    const origins = createAgentOrigins({ agents: registryOf(archived, untitled), logger });
    expect(origins.identify(["c1", "c2", "gone"])).toEqual({
        c1: { provider: "claude", title: "fix the thing" },
        // No title ⇒ the key is absent rather than empty, and an id with no entry left at all is omitted
        // entirely — the panel's id-shaped fallback is what covers it.
        c2: { provider: "claude" },
    });
});

test("the claim expires when the user commits — a file that goes dirty again is theirs, not the agent's", async () => {
    const { work, worktrees, conversation } = await setup();
    await writeFile(join(conversation.cwd, "app.ts"), edited(1));
    const landed = await landAgent(worktrees, entryFor(conversation.repos));
    const origins = createAgentOrigins({ agents: registryOf(entryFor(landed.repos)), logger });
    expect(await origins.forRepo("root", work)).toEqual({ "app.ts": ["c1"] });

    // The user reviews and commits it. HEAD moves off the sha the land was recorded against…
    await sh(work, "add", "-A");
    await sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "reviewed");
    // …so a later edit of the same file by the user is never credited to the agent.
    await writeFile(join(work, "app.ts"), `${edited(1)}mine\n`);
    expect(await origins.forRepo("root", work)).toEqual({});
});
