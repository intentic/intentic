import type { RepoSync } from "../../../conversations/land/sync.js";
import type { ConversationWorktree } from "../../../conversations/worktrees/worktrees.js";
import { type WorktreeFrame, worktreeFrame } from "./worktree-placement.js";

const worktree = (repos: ConversationWorktree["repos"]): ConversationWorktree => ({
    cwd: "/w",
    branch: "agent/c",
    repos,
    fenced: false,
    elsewhere: [],
});
const moved = (repo: string, commits: number): RepoSync => ({ repo, onto: "f".repeat(40), commits, moved: [], overlap: [] });
const blocked = (repo: string): RepoSync => ({ repo, onto: "e".repeat(40), commits: 0, moved: [], overlap: [], blocked: true });

describe("where the branch stands", () => {
    const frames: [string, ConversationWorktree, ReadonlyMap<string, string>, boolean, readonly RepoSync[], WorktreeFrame][] = [
        [
            "names the root repo's base, cut to seven",
            worktree([
                { repo: "web", base: "b".repeat(40) },
                { repo: "root", base: "a".repeat(40) },
            ]),
            new Map(),
            true,
            [],
            { kind: "worktree", branch: "agent/c", base: "aaaaaaa" },
        ],
        [
            "names the first repo's when there is no root",
            worktree([{ repo: "web", base: "b".repeat(40) }]),
            new Map(),
            true,
            [],
            { kind: "worktree", branch: "agent/c", base: "bbbbbbb" },
        ],
        ["names nothing when there are no repos", worktree([]), new Map(), true, [], { kind: "worktree", branch: "agent/c", base: "" }],
        [
            "names where a rebase moved the root",
            worktree([{ repo: "root", base: "a".repeat(40) }]),
            new Map([["root", "c".repeat(40)]]),
            true,
            [],
            { kind: "worktree", branch: "agent/c", base: "ccccccc" },
        ],
        [
            "says when the container cannot enforce the tree",
            worktree([{ repo: "root", base: "a".repeat(40) }]),
            new Map(),
            false,
            [],
            { kind: "worktree", branch: "agent/c", base: "aaaaaaa", unenforced: true },
        ],
        [
            "counts what a rebase moved and names what it could not",
            worktree([{ repo: "root", base: "a".repeat(40) }]),
            new Map(),
            true,
            [moved("root", 2), moved("web", 3), blocked("docs")],
            { kind: "worktree", branch: "agent/c", base: "aaaaaaa", sync: { commits: 5, blocked: ["docs"] } },
        ],
        [
            "reports a rebase that found nothing to move",
            worktree([{ repo: "root", base: "a".repeat(40) }]),
            new Map(),
            true,
            [moved("root", 0)],
            { kind: "worktree", branch: "agent/c", base: "aaaaaaa", sync: { commits: 0, blocked: [] } },
        ],
    ];
    test.each(frames)("%s", (_case, composed, onto, enforced, synced, frame) => {
        expect(worktreeFrame(composed, onto, enforced, synced)).toStrictEqual(frame);
    });
});
