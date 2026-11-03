import type { GitRunner } from "@intentic/base/git";
import { chunkPaths, commitOnly, discardPaths, unstagePaths } from "./changes-index.js";
import { headSha } from "./changes.js";

// Only an answer from git may read as "no HEAD"; the unborn spelling of discard untracks the tree and cleans it.

// Answers rev-parse with `head`, records every verb after it; `head` as an Error is how that one call fails.
const gitWithHead = (head: string | Error): { readonly git: GitRunner; readonly verbs: string[] } => {
    const verbs: string[] = [];
    const git: GitRunner = async (_dir, args) => {
        if (args[0] === "rev-parse") {
            if (head instanceof Error) {
                throw head;
            }
            return { stdout: `${head}\n`, stderr: "" };
        }
        verbs.push(args.join(" "));
        return { stdout: "", stderr: "" };
    };
    return { git, verbs };
};

const exited = (code: number): Error => Object.assign(new Error(`git exited ${code}`), { code });

test("an exit status is git's answer that there is no HEAD; a git that never answered is not", async () => {
    expect(await headSha("/repo", gitWithHead("abc123").git)).toBe("abc123");
    expect(await headSha("/repo", gitWithHead(exited(1)).git)).toBeUndefined();
    expect(await headSha("/repo", gitWithHead(exited(128)).git)).toBeUndefined();
    await expect(headSha("/repo", gitWithHead(new Error("git forker exited")).git)).rejects.toThrow("git forker exited");
    const spawnFailure = Object.assign(new Error("spawn git EAGAIN"), { code: "EAGAIN" });
    await expect(headSha("/repo", gitWithHead(spawnFailure).git)).rejects.toThrow("spawn git EAGAIN");
});

test("discarding everything after a failed HEAD read moves nothing, instead of untracking and cleaning the tree", async () => {
    const { git, verbs } = gitWithHead(new Error("git forker exited"));
    await expect(discardPaths("/repo", undefined, git)).rejects.toThrow("git forker exited");
    expect(verbs).toEqual([]);
});

test("unstaging after a failed HEAD read moves nothing, instead of staging the paths' deletion", async () => {
    const { git, verbs } = gitWithHead(new Error("git forker exited"));
    await expect(unstagePaths("/repo", ["a.txt"], git)).rejects.toThrow("git forker exited");
    expect(verbs).toEqual([]);
});

test("an unborn HEAD still takes the unborn spelling", async () => {
    const { git, verbs } = gitWithHead(exited(1));
    await discardPaths("/repo", undefined, git);
    expect(verbs).toEqual(["rm -r -q --cached --ignore-unmatch -- .", "clean -q -f -f -d"]);
});

test("paths are split into runs that each fit one command line, in order and losing nothing", () => {
    // 40 KiB per path; three of five exceed the ~96 KiB budget this splits on.
    const long = Array.from({ length: 5 }, (_, index) => `${index}/${"p".repeat(40 * 1024)}`);
    const chunks = chunkPaths(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(long);
    for (const chunk of chunks) {
        expect(chunk.reduce((total, path) => total + Buffer.byteLength(path, "utf8") + 1, 0)).toBeLessThanOrEqual(96 * 1024);
    }
    // An ordinary short list must stay one call, not one process per path.
    expect(chunkPaths(["a.ts", "b.ts"])).toEqual([["a.ts", "b.ts"]]);
    expect(chunkPaths([])).toEqual([]);
});

test("a single path past the budget still gets a call of its own rather than being dropped", () => {
    const huge = "x".repeat(200 * 1024);
    expect(chunkPaths([huge, "a.ts"])).toEqual([[huge], ["a.ts"]]);
});

// commitOnly: the commit is a private index read from HEAD with the paths staged into it, never `commit --only`, which
// re-reads them from disk under core.fileMode=false and drops a +x the staging recorded.

// A git runner that answers rev-parse with `head`, records every call with its args and env, and lets the caller decide
// whether the emptiness check reports changes (by throwing on it).
const commitGit = (head: string, { diffThrows }: { diffThrows: boolean }) => {
    const calls: { args: string[]; index: string | undefined }[] = [];
    const git: GitRunner = async (_dir, args, env) => {
        if (args[0] === "rev-parse") {
            return { stdout: `${head}\n`, stderr: "" };
        }
        calls.push({ args: [...args], index: env?.["GIT_INDEX_FILE"] });
        if (args.includes("--quiet") && diffThrows) {
            throw Object.assign(new Error("diff exit 1"), { code: 1 });
        }
        return { stdout: "", stderr: "" };
    };
    return { git, calls };
};

test("commitOnly stages the paths in both indexes and commits the private one whole, in chunks however many paths", async () => {
    // Enough 40 KiB paths that chunkPaths splits them into several runs.
    const paths = Array.from({ length: 5 }, (_, i) => `${i}/${"p".repeat(40 * 1024)}`);
    const { git, calls } = commitGit("abc123", { diffThrows: true });

    expect(await commitOnly("/repo", paths, "chore: bulk", { name: "t", email: "t@t" }, git)).toBe(true);

    const adds = calls.filter(({ args }) => args[0] === "add");
    const ownAdds = adds.filter(({ index }) => index === undefined);
    const privateAdds = adds.filter(({ index }) => index !== undefined);
    expect(ownAdds.length).toBe(privateAdds.length);
    expect(ownAdds.length).toBeGreaterThan(1);
    expect(calls.filter(({ args }) => args.includes("--quiet")).map(({ index }) => index !== undefined)).toEqual([true]);
    const read = calls.find(({ args }) => args[0] === "read-tree");
    expect(read?.args).toEqual(["read-tree", "abc123"]);
    const commits = calls.filter(({ args }) => args.includes("commit"));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.index).toBe(read?.index);
    expect(commits[0]?.args.slice(-4)).toEqual(["commit", "-q", "-m", "chore: bulk"]);
    expect(commits[0]?.args).not.toContain("--only");
});

test("commitOnly returns false when the diff check shows no changes", async () => {
    const paths = ["src/a.ts"];
    const { git } = commitGit("abc123", { diffThrows: false });

    const result = await commitOnly("/repo", paths, "chore: noop", { name: "t", email: "t@t" }, git);
    expect(result).toBe(false);
});

test("commitOnly returns false for an empty path list", async () => {
    const { git } = commitGit("abc123", { diffThrows: true });
    const result = await commitOnly("/repo", [], "chore: empty", { name: "t", email: "t@t" }, git);
    expect(result).toBe(false);
});
