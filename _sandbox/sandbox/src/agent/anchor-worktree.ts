import type { RepoBase } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { Logger } from "pino";
import { headSha } from "../git/changes.js";
import { commitWorktreeRemainder } from "../git/root-repo.js";
import type { AgentWorktrees } from "../agents/worktrees.js";
import type { TurnAnchor } from "./turn-anchors.js";

/* PIN AN ISOLATED CONVERSATION'S CHECKOUT WHERE IT STANDS — the isolated half of a turn's before-state.
 *
 * A main-tree turn is anchored by the workspace history: a capture before the agent runs, filed under the
 * message. An isolated turn has no such thing, because history covers /work and an isolated turn never touches
 * it. What it has instead is a branch of its own, and the equivalent gesture is this one: commit whatever the
 * checkout is holding, then read back the commit per repo.
 *
 * WHY COMMIT RATHER THAN JUST READ HEAD. Between turns the checkout accumulates: an agent's edits are not
 * committed until it lands, syncs or is archived, so HEAD alone names a state that is missing everything the
 * previous turns actually did. Anchoring on it would send a rewind — or a fork asking for these files — back
 * past work nobody asked to undo. On the ordinary clean checkout there is nothing to commit and this is one
 * `status` and one `rev-parse`; the commit only happens where there is something that would otherwise be lost,
 * which is exactly the attribution the main tree's fence capture performs for the same reason.
 *
 * NOTHING HERE IS FATAL. A repo that will not commit, or has no checkout at all, drops out of the anchor and
 * the rest still stands; an anchor covering some repos is better than none, and a turn must never fail because
 * its bookmark could not be written. The caller records nothing when the list comes back empty. */

export interface AnchorDeps {
    readonly agentWorktrees: Pick<AgentWorktrees, "worktreeDir">;
    readonly logger: Logger;
}

/* WHERE A FORK'S CHECKOUT STARTS when it asked for the files as they were at the cut — the read half of the
 * anchors above, and the only place `forkOf.files: "then"` turns into anything.
 *
 * Answers undefined for every case that cannot honour it, and the caller then creates the fork's checkout the
 * ordinary way (today's files) rather than refusing the turn: the fork is still the fork the user asked for,
 * and starting it is worth more than failing over the half of the request that cannot be served. Those cases
 * are a source that has no anchor at that message, and a source that worked on the MAIN TREE — whose anchor is
 * a workspace checkpoint, which is a different kind of thing from a commit a checkout can be created at.
 *
 * The shas come from the daemon's own record of the source, never from the request. A client that could name
 * the commit a new checkout starts at could start one anywhere in the repository. */
export const forkWorktreeBase = async (
    anchors: { readonly of: (conversationId: string, index: number) => Promise<TurnAnchor | undefined> },
    forkOf: { readonly conversationId: string; readonly keep: number; readonly files: "then" | "now" } | undefined,
): Promise<RepoBase[] | undefined> => {
    if (forkOf?.files !== "then") {
        return undefined;
    }
    const anchor = await anchors.of(forkOf.conversationId, forkOf.keep);
    return anchor?.kind === "worktree" ? [...anchor.repos] : undefined;
};

export const anchorWorktree = async (
    services: AnchorDeps,
    conversationId: string,
    repos: readonly { repo: string; base: string }[],
    git: GitRunner = defaultGit,
): Promise<RepoBase[]> => {
    const anchored: RepoBase[] = [];
    for (const { repo } of repos) {
        const dir = services.agentWorktrees.worktreeDir(conversationId, repo);
        try {
            /* ONE spawn to answer "is there anything to keep", which is the answer in the common case — the
             * same probe (and the same reasoning) the archive path uses before it commits a remainder. Porcelain
             * covers staged, unstaged AND untracked, which is what the commit would sweep; it also OVER-reports,
             * so the decision about what actually goes in stays with commitWorktreeRemainder and its index. */
            const { stdout } = await git(dir, ["status", "--porcelain", "-z"]);
            if (stdout !== "") {
                // Titled as the turn boundary it is, so a reader of `git log` on the branch can see where each
                // turn began rather than a run of identically-named commits.
                await commitWorktreeRemainder(repo, dir, `Agent: before this turn`, git);
            }
            const base = await headSha(dir, git);
            if (base !== undefined) {
                anchored.push({ repo, base });
            }
        } catch (error) {
            services.logger.warn({ err: error, conversationId, repo }, "anchors: pinning the worktree failed");
        }
    }
    return anchored;
};
