import { expect, test, vi } from "vitest";
import { anchorWorktree, type AnchorDeps, forkWorktreeBase } from "./anchor-worktree.js";
import type { TurnAnchor } from "./turn-anchors.js";

const CONVERSATION = "conv-1";
const REPOS = [
    { repo: "root", base: "old-root" },
    { repo: "intent", base: "old-intent" },
];

const services = { agentWorktrees: { worktreeDir: (_id: string, repo: string) => `/w/${repo}` }, logger: { warn: vi.fn() } } as unknown as AnchorDeps;

/* Stands in for git: `dirty` names the repos whose checkout has something in it, `broken` the ones that throw.
 * HEAD reads back as a commit that says whether this repo was committed on the way through, which is what lets
 * the assertions below tell "we pinned what was there" from "we pinned a stale HEAD". */
const gitFake = (options: { dirty?: readonly string[]; broken?: readonly string[] } = {}) => {
    const calls: string[] = [];
    const git = async (dir: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
        const repo = dir.split("/").at(-1) ?? "";
        if (options.broken?.includes(repo) === true) {
            throw new Error(`no checkout at ${dir}`);
        }
        const verb = args[0] ?? "";
        calls.push(`${verb}:${repo}`);
        if (verb === "status") {
            return { stdout: options.dirty?.includes(repo) === true ? "M file.ts\0" : "", stderr: "" };
        }
        if (verb === "rev-parse") {
            return { stdout: `${calls.includes(`commit:${repo}`) || calls.includes(`add:${repo}`) ? "new" : "head"}-${repo}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
    };
    return { git, calls };
};

// The common case by far, and the one that has to stay cheap: nothing to keep, so nothing is written, the
// anchor is just where the branch already stands.
test("a clean checkout is pinned without committing anything", async () => {
    const { git, calls } = gitFake();

    const anchored = await anchorWorktree(services, CONVERSATION, REPOS, git);

    expect(anchored).toEqual([
        { repo: "root", base: "head-root" },
        { repo: "intent", base: "head-intent" },
    ]);
    expect(calls.filter((call) => call.startsWith("commit") || call.startsWith("add"))).toEqual([]);
});

/* The case the anchor exists for. Between turns an agent's edits sit in the checkout uncommitted, so pinning
 * HEAD alone would name a state missing everything the previous turns did, and a fork or a rewind aimed at
 * this message would silently throw that work away. */
test("a checkout holding work commits it before pinning, so the anchor includes it", async () => {
    const { git, calls } = gitFake({ dirty: ["root"] });

    const anchored = await anchorWorktree(services, CONVERSATION, REPOS, git);

    expect(calls).toContain("add:root");
    expect(anchored).toContainEqual({ repo: "root", base: "new-root" });
    // The clean repo beside it is untouched and still pinned.
    expect(anchored).toContainEqual({ repo: "intent", base: "head-intent" });
});

// Nothing here is fatal: a repo that will not answer drops out and the rest still anchor, because a bookmark
// covering some repos beats a turn that failed over writing one.
test("a repo that refuses drops out of the anchor without taking the others with it", async () => {
    const { git } = gitFake({ broken: ["root"] });

    expect(await anchorWorktree(services, CONVERSATION, REPOS, git)).toEqual([{ repo: "intent", base: "head-intent" }]);
});

const anchors = (anchor: TurnAnchor | undefined) => ({ of: async () => anchor });

/* WHERE A FORK STARTS. "Files as they were" is answerable only from the source's own commits, so an isolated
 * source hands them over and everything else falls through to today's files rather than refusing the fork. */
test("a fork asking for the files as they were starts at the source's commits for that message", async () => {
    const anchor: TurnAnchor = { kind: "worktree", repos: [{ repo: "root", base: "sha-root" }] };

    expect(await forkWorktreeBase(anchors(anchor), { conversationId: "src", keep: 4, files: "then" })).toEqual([{ repo: "root", base: "sha-root" }]);
});

test("a fork that wants today's files names no base at all", async () => {
    const anchor: TurnAnchor = { kind: "worktree", repos: [{ repo: "root", base: "sha-root" }] };

    expect(await forkWorktreeBase(anchors(anchor), { conversationId: "src", keep: 4, files: "now" })).toBeUndefined();
    expect(await forkWorktreeBase(anchors(anchor), undefined)).toBeUndefined();
});

/* A MAIN-TREE source's anchor is a workspace checkpoint, which is not a commit a checkout can be created at:
 * so the fork starts on today's files. It is still the fork the user asked for; what it cannot do is carry the
 * old files, and the menu that offered it does not claim otherwise for a chat on the shared workspace. */
test("a main-tree source, and a message with no anchor, both fall through to today's files", async () => {
    expect(await forkWorktreeBase(anchors({ kind: "tree", snapshot: "snap-1" }), { conversationId: "src", keep: 4, files: "then" })).toBeUndefined();
    expect(await forkWorktreeBase(anchors(undefined), { conversationId: "src", keep: 4, files: "then" })).toBeUndefined();
});
