import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { unstubbed } from "@intentic/testing";
import type { PersistedAgent } from "../../agents/registry/agents-store.js";
import type { Services } from "../../composition.js";
import { taskStoreDir } from "../run/task-store.js";
import { HANDOFF_STATE_NOTE_TITLE, type HandoffStateDeps, handoffStateNote } from "./handoff-state.js";

const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
};

// A repository with one committed file and one change on top of it: the shape the note reads.
const repoWithChange = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "agent/x");
    writeFileSync(join(dir, "src.ts"), "one\n");
    git(dir, "add", "src.ts");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "src.ts"), "one\ntwo\n");
    writeFileSync(join(dir, "new.ts"), "fresh\n");
};

const fakeDeps = (root: string, entry: PersistedAgent | undefined, worktree: string): HandoffStateDeps => ({
    agents: unstubbed<Services["agents"]>("agents", { entry: () => entry }),
    agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", {
        attached: async () => true,
        worktreeDir: () => worktree,
        mainDir: (repo: string) => (repo === "root" ? root : join(root, repo)),
    }),
    workspace: unstubbed<Services["workspace"]>("workspace", { root }),
    logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
});

const isolated = (id: string): PersistedAgent => ({ id, branch: "agent/x", repos: [{ repo: "root", base: "0000" }] }) as PersistedAgent;

/* WHAT THE NOTE SAYS, from readings rather than recall: git for the branch, the ledger for the proof, the CLI's
 * own task store for the checklist. Paths and counts, never contents. */
test("measures the branch, the proof and the checklist, and points rather than pastes", async () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-"));
    const worktree = join(root, "wt");
    repoWithChange(worktree);
    const store = taskStoreDir(root, "s-old");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "1.json"), JSON.stringify({ id: "1", subject: "Read the schema", status: "completed" }));
    writeFileSync(join(store, "2.json"), JSON.stringify({ id: "2", subject: "Wire the route", status: "in_progress" }));

    const note = await handoffStateNote(fakeDeps(root, isolated("c1"), worktree), {
        conversationId: "c1",
        standing: { state: "unproven", paths: [`${worktree}/src.ts`], check: undefined },
        retiredSessionId: "s-old",
        now: Date.UTC(2026, 8, 7, 14, 32),
    });

    expect(note?.title).toBe(HANDOFF_STATE_NOTE_TITLE);
    const text = note?.text ?? "";
    expect(text).toContain("Measured by the sandbox at 14:32 UTC, not recalled");
    expect(text).toContain("### On this conversation's own branch");
    // Two files changed on the tree (the edit and the untracked one), counted from git's own status.
    expect(text).toMatch(/`root`: 2 files changed \(\+\d+ −\d+; 2 unstaged\)/u);
    expect(text).toContain("src.ts, new.ts");
    // What the interrupted turn touched and whether anything proved it.
    expect(text).toContain("Edited by the interrupted turn: wt/src.ts");
    expect(text).toContain("Verification: unproven, no check ran after the last edit");
    // The checklist as the store keeps it, with the open items to re-create.
    expect(text).toContain("(1 of 2 open)");
    expect(text).toContain("- [x] Read the schema");
    expect(text).toContain("- [ ] Wire the route (was in progress)");
    expect(text).toContain("Re-create the 1 open item in your own task list");
    // Pointers only: nothing of the files' contents crosses.
    expect(text).not.toContain("fresh");
});

// The main tree is everybody's, so only the paths the turn itself edited are read, grouped by repository.
test("on the main tree reads only what the turn edited", async () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-"));
    repoWithChange(root);
    writeFileSync(join(root, "other.ts"), "somebody else's\n");
    const note = await handoffStateNote(fakeDeps(root, { id: "c2", repos: [] } as unknown as PersistedAgent, root), {
        conversationId: "c2",
        standing: { state: "verified", paths: ["src.ts"], check: "pnpm test" },
    });
    const text = note?.text ?? "";
    expect(text).toContain("### On the shared tree, the paths the last turn edited");
    expect(text).toMatch(/`root`: 1 file changed/u);
    expect(text).toContain("src.ts");
    expect(text).not.toContain("other.ts");
    expect(text).not.toContain("new.ts");
    expect(text).toContain("Verification: passed, `pnpm test` ran green after the last edit.");
});

// A checklist the fold saw stands in when no session store is readable; a failing check is named from the
// registry when no ledger survives the hand-off.
test("falls back to the fold's checklist and the registry's failed check", async () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-"));
    const entry = { id: "c3", repos: [], unfinished: { at: 1, check: "verify:turn" } } as unknown as PersistedAgent;
    const note = await handoffStateNote(fakeDeps(root, entry, root), {
        conversationId: "c3",
        checklist: [{ content: "Write the tests", status: "pending" }],
    });
    const text = note?.text ?? "";
    expect(text).toContain("- [ ] Write the tests");
    expect(text).toContain("the end-of-turn check `verify:turn` was still failing");
});

// Nothing measured is no note at all, not an empty one.
test("says nothing when there is nothing to measure", async () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-"));
    expect(await handoffStateNote(fakeDeps(root, { id: "c4", repos: [] } as unknown as PersistedAgent, root), { conversationId: "c4" })).toBeUndefined();
});

// Past the cap the paths go first; the counts and verdicts stay.
test("drops paths before facts when the note would exceed its cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-"));
    const worktree = join(root, "wt");
    repoWithChange(worktree);
    // Forty paths of this length per section is past the cap on its own: the fixture has to exceed it, or the
    // test measures the full render and says nothing about the terse one.
    const name = (index: number): string => `a-very-long-file-name-that-takes-a-great-deal-of-room-on-the-line-and-then-some-more-${index}.ts`;
    for (let index = 0; index < 60; index += 1) {
        writeFileSync(join(worktree, name(index)), "x\n");
    }
    const note = await handoffStateNote(fakeDeps(root, isolated("c5"), worktree), {
        conversationId: "c5",
        standing: { state: "unproven", paths: Array.from({ length: 60 }, (_, index) => `${worktree}/${name(index)}`), check: undefined },
    });
    const text = note?.text ?? "";
    expect(text.length).toBeLessThanOrEqual(6_010);
    expect(text).toMatch(/`root`: 62 files changed/u);
    expect(text).toContain("Edited by the interrupted turn: 60 files");
});
