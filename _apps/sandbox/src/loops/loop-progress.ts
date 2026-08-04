import { createHash } from "node:crypto";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { discoverRepos } from "../workspace/repo-discovery.js";

/* DID THE TREE MOVE? — the stall detector, and the guardrail that earns its keep more than any other here.
 *
 * The failure mode of an unattended loop is not runaway success. It is an agent that reads the same three
 * files, restates the same plan, concludes that work remains, and does it again — eleven times, at a turn's
 * cost each. Every one of those turns SUCCEEDS. No error is raised, no ceiling is hit, the stop condition
 * honestly reports "not yet", and the loop is behaving exactly as specified while achieving nothing. The only
 * signal that separates it from real progress is that nothing changed on disk.
 *
 * WHAT COUNTS AS THE TREE. A digest over every repo the conversation can write to: HEAD's sha (work that was
 * committed) and the porcelain status (work that was not). Both halves are needed and each covers the other's
 * blind spot — an iteration that commits leaves the status clean, an iteration that edits without committing
 * leaves HEAD where it was, and either alone would read half of a working loop as a stall.
 *
 * WHAT IT DELIBERATELY DOES NOT COUNT. The loop's own directory is under `.intentic`, which is outside every
 * repo, so a progress file rewritten with "still working on it" never registers as progress. That is the point:
 * the one thing a stalling agent reliably does is update its own notes.
 *
 * Cheap by construction — two git plumbing calls per repo, no diff, no object walk — because it runs twice per
 * iteration and a loop is already the most expensive thing in the sandbox.
 */

// A repo whose status is enormous (a fresh clone mid-checkout, a build output someone unignored) would put
// megabytes through the hash for no gain: the digest only has to CHANGE, not to describe. Bounded so one
// pathological repo cannot make the check itself the slow part.
const STATUS_MAX = 256_000;

const repoDigest = async (dir: string, git: GitRunner): Promise<string> => {
    // Both reads tolerate a dir that is not a repo, is mid-checkout, or has an unborn HEAD: the digest's
    // contract is only that equal digests mean nothing moved, and a repo that consistently fails to answer
    // consistently contributes the same empty string. It is the tree's OTHER repos that carry the signal.
    //
    // Concurrently, and so is every repo in the caller: neither read depends on the other's answer, and the two
    // of them are the atom this whole pass is made of. See treeDigest.
    const [head, status] = await Promise.all([
        git(dir, ["rev-parse", "-q", "--verify", "HEAD"]).catch(() => ({ stdout: "" })),
        git(dir, ["status", "--porcelain", "--untracked-files=all"]).catch(() => ({ stdout: "" })),
    ]);
    return `${head.stdout.trim()}\n${status.stdout.slice(0, STATUS_MAX)}`;
};

/* The digest of everything one iteration could have changed. `root` is the tree the conversation works in — an
 * isolated conversation's worktree, or the workspace itself.
 *
 * The repo list is re-discovered per call rather than taken from the registry entry, and that is deliberate:
 * an iteration is perfectly entitled to CLONE a repo or scaffold a new app, and a digest over a list fixed
 * before the loop began would score that — one of the largest changes an iteration can make — as no change at
 * all. Discovery is a bounded directory walk (see repo-discovery.ts), which is the same order of cost as the
 * git calls it feeds.
 *
 * EVERY REPO AT ONCE, and here that is not a micro-optimisation — it is the difference between the stall
 * detector costing one git round-trip and costing a whole composition's worth of them, twice per iteration, at
 * the two moments somebody is watching a clock. "Cheap by construction" was written when a workspace was one
 * repo or two; this one grew to six, so the pass quietly became twelve sequential spawns before the turn starts
 * and twelve more after it is stopped. On a busy daemon each `await` also pays whatever the event loop is
 * behind by, which is how a few hundred milliseconds of git became seconds of visible warm-up. No repo reads
 * another's answer, so there was never an ordering to keep here — only the HASH's, which the sort still fixes.
 */
export const treeDigest = async (root: string, git: GitRunner = defaultGit): Promise<string> => {
    const repos = (await discoverRepos(root)).toSorted();
    // The root repo itself first — the whole workspace is version-controlled (git/root-repo.ts), so a change to
    // a file that belongs to no nested repo lives here and nowhere else.
    const digests = await Promise.all([root, ...repos.map((repo) => join(root, repo))].map((dir) => repoDigest(dir, git)));
    const hash = createHash("sha256");
    hash.update(digests[0] ?? "");
    for (const [index, repo] of repos.entries()) {
        hash.update(`\u0000${repo}\u0000`);
        hash.update(digests[index + 1] ?? "");
    }
    return hash.digest("hex");
};
