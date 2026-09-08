import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";

// Detects a stalled loop: iterations that succeed yet change nothing on disk. Tracks each repo's HEAD sha plus
// porcelain status (committed and uncommitted work); `.intentic` is outside every repo, so rewriting the progress file
// alone never counts as progress. Two cheap git plumbing calls per repo, no diff or object walk.

// Caps status bytes hashed; the digest only needs to change, not describe, so a huge repo can't slow the check.
const STATUS_MAX = 256_000;

const repoDigest = async (dir: string, git: GitRunner): Promise<string> => {
    // Tolerates a non-repo, mid-checkout, or unborn HEAD (falls back to empty string); both calls run concurrently.
    const [head, status] = await Promise.all([
        git(dir, ["rev-parse", "-q", "--verify", "HEAD"]).catch(() => ({ stdout: "" })),
        git(dir, ["status", "--porcelain", "--untracked-files=all"]).catch(() => ({ stdout: "" })),
    ]);
    return `${head.stdout.trim()}\n${status.stdout.slice(0, STATUS_MAX)}`;
};

// `root` is the conversation's own tree (a worktree or the main workspace). Repos are rediscovered per call so a newly
// cloned repo counts, and digested concurrently to keep the pass to one round trip.
export const treeDigest = async (root: string, git: GitRunner = defaultGit): Promise<string> => {
    const repos = (await discoverRepos(root)).toSorted();
    // Root repo first: the workspace itself is version-controlled (git/root-repo.ts), outside every nested repo.
    const digests = await Promise.all([root, ...repos.map((repo) => join(root, repo))].map((dir) => repoDigest(dir, git)));
    const hash = createHash("sha256");
    hash.update(digests[0] ?? "");
    for (const [index, repo] of repos.entries()) {
        hash.update(`\u0000${repo}\u0000`);
        hash.update(digests[index + 1] ?? "");
    }
    return hash.digest("hex");
};
