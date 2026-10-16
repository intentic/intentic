import { checkpointNote, checkpointWorktree, type CheckpointDeps, forkWorktreeBase, takeCheckpointNote } from "./checkpoint-worktree.js";
import type { TurnCheckpoint } from "../../store/journals/turn-checkpoints.js";

const CONVERSATION = "conv-1";
const REPOS = [
    { repo: "root", base: "old-root" },
    { repo: "intent", base: "old-intent" },
];
// Commit title where there is something to keep; only ever read by a human, so tests assert nothing about it.
const TITLE = "Agent: before this turn";

const services = {
    agentWorktrees: { worktreeDir: (_id: string, repo: string) => `/w/${repo}`, mainDir: (repo: string) => `/main/${repo}` },
    logger: { warn: jest.fn(), info: jest.fn() },
} as unknown as CheckpointDeps;

// Finds the git verb the way git does: `-c key=value` pairs come before the subcommand, so the first token isn't it.
const subcommandOf = (args: readonly string[]): string => {
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index] ?? "";
        if (arg === "-c") {
            index += 1;
            continue;
        }
        if (!arg.startsWith("-")) {
            return arg;
        }
    }
    return "";
};

// Stands in for git: `dirty` names repos with uncommitted changes, `broken` ones that throw. The rev-parse result
// reflects whether a commit happened, so assertions can tell a fresh pin from a stale HEAD.
const gitFake = (options: { dirty?: readonly string[]; broken?: readonly string[] } = {}) => {
    const calls: string[] = [];
    const git = async (dir: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> => {
        const repo = dir.split("/").at(-1) ?? "";
        if (options.broken?.includes(repo) === true) {
            throw new Error(`no checkout at ${dir}`);
        }
        const verb = subcommandOf(args);
        calls.push(`${verb}:${repo}`);
        const dirty = options.dirty?.includes(repo) === true;
        if (verb === "status") {
            return { stdout: dirty ? "M file.ts\0" : "", stderr: "" };
        }
        // `diff --cached --quiet` exits non-zero when the index differs from HEAD, which is what makes commitIndex commit.
        if (verb === "diff" && args.includes("--cached") && dirty) {
            throw new Error("exit 1");
        }
        if (verb === "diff-tree") {
            return { stdout: "file.ts\0other.ts\0", stderr: "" };
        }
        if (verb === "rev-parse") {
            return { stdout: `${calls.includes(`commit:${repo}`) || calls.includes(`add:${repo}`) ? "new" : "head"}-${repo}\n`, stderr: "" };
        }
        return { stdout: "", stderr: "" };
    };
    return { git, calls };
};

test("a clean checkout is pinned without committing anything", async () => {
    const { git, calls } = gitFake();

    const anchored = await checkpointWorktree(services, CONVERSATION, REPOS, TITLE, git);

    expect(anchored).toEqual([
        { repo: "root", base: "head-root" },
        { repo: "intent", base: "head-intent" },
    ]);
    expect(calls.filter((call) => call.startsWith("commit") || call.startsWith("add"))).toEqual([]);
});

// The checkpoint exists for this: uncommitted edits between turns would be missing from a HEAD-only pin, so a fork or
// rewind aimed at this message would silently lose that work.
test("a checkout holding work commits it before pinning, so the checkpoint includes it", async () => {
    const { git, calls } = gitFake({ dirty: ["root"] });

    const anchored = await checkpointWorktree(services, CONVERSATION, REPOS, TITLE, git);

    expect(calls).toContain("add:root");
    expect(anchored).toContainEqual({ repo: "root", base: "new-root" });
    expect(anchored).toContainEqual({ repo: "intent", base: "head-intent" });
});

// A clean `git status` after a resume read as lost work, until the prompt said where it went.
test("a commit of the checkout's work is told once, in the next prompt, with how to see it", async () => {
    const { git } = gitFake({ dirty: ["root"] });
    const messages: string[] = [];
    const recording = { ...services, logger: { warn: jest.fn(), info: jest.fn() } } as unknown as CheckpointDeps;
    const gitRecording = async (dir: string, args: readonly string[]) => {
        const commit = args.indexOf("-m");
        if (commit !== -1) {
            messages.push(args[commit + 1] ?? "");
        }
        return git(dir, args);
    };

    await checkpointWorktree(recording, "conv-told", REPOS, TITLE, gitRecording);

    // Every agent commit has one author; the trailer is what says whose conversation made it.
    expect(messages).toEqual([`${TITLE}\n\nConversation-Id: conv-told`]);
    const note = takeCheckpointNote("conv-told");
    expect(note?.title).toBe("Uncommitted work committed");
    expect(note?.text).toContain(`root: 2 files committed as new-root "${TITLE}"`);
    expect(note?.text).toContain("git diff new-root~1");
    expect(takeCheckpointNote("conv-told")).toBeUndefined();
});

test("a clean checkout leaves nothing to tell", async () => {
    const { git } = gitFake();
    await checkpointWorktree(services, "conv-clean", REPOS, TITLE, git);
    expect(takeCheckpointNote("conv-clean")).toBeUndefined();
    expect(checkpointNote([])).toBeUndefined();
});

test("a repo that refuses drops out of the checkpoint without taking the others with it", async () => {
    const { git } = gitFake({ broken: ["root"] });

    expect(await checkpointWorktree(services, CONVERSATION, REPOS, TITLE, git)).toEqual([{ repo: "intent", base: "head-intent" }]);
});

const checkpoints = (checkpoint: TurnCheckpoint | undefined) => ({ of: async () => checkpoint });

// Old files are answerable only from the source's own commits; anything else falls through to today's files rather than
// refusing the fork.
test("a fork asking for the files as they were starts at the source's commits for that message", async () => {
    const checkpoint: TurnCheckpoint = { kind: "worktree", repos: [{ repo: "root", base: "sha-root" }] };

    expect(await forkWorktreeBase(checkpoints(checkpoint), { conversationId: "src", keep: 4, files: "then" })).toEqual([
        { repo: "root", base: "sha-root" },
    ]);
});

test("a fork that wants today's files names no base at all", async () => {
    const checkpoint: TurnCheckpoint = { kind: "worktree", repos: [{ repo: "root", base: "sha-root" }] };

    expect(await forkWorktreeBase(checkpoints(checkpoint), { conversationId: "src", keep: 4, files: "now" })).toBeUndefined();
    expect(await forkWorktreeBase(checkpoints(checkpoint), undefined)).toBeUndefined();
});

// A main-tree checkpoint is a workspace checkpoint, not a commit a checkout can be created at, so the fork starts on
// today's files anyway.
test("a main-tree source, and a message with no checkpoint, both fall through to today's files", async () => {
    expect(
        await forkWorktreeBase(checkpoints({ kind: "tree", snapshot: "snap-1" }), { conversationId: "src", keep: 4, files: "then" }),
    ).toBeUndefined();
    expect(await forkWorktreeBase(checkpoints(undefined), { conversationId: "src", keep: 4, files: "then" })).toBeUndefined();
});
