import type { GitRunner } from "@intentic/scaffold";
import { discardPaths, unstagePaths } from "./changes-index.js";
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
