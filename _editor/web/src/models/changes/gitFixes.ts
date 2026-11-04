import type { PushRun } from "@intentic/sandbox-contract/schemas/git/git";
import type { AgentFix } from "../fixes/agentFix";

// What a Fix with agent press asks about each git failure the Changes panel and the push card show (agentFix.ts). Every
// one of them is about the owner's own checkout (its commits, its index, its remote), so every one works in it: a copy
// would repair a branch nobody is looking at. The words are the agent's, so they are English, like every brief the app
// composes for one.

const LEVEL_WITH_UPSTREAM =
    `Bring this repository level with its upstream: fetch, then replay my local commits onto it (rebase, unless this repository's history shows it merges instead), ` +
    `resolving each conflict by reading both sides and keeping what each side meant. Run this repository's own checks over what you touched.`;

/** A pull, or the pull half of a sync, that git refused: a conflict between my commits and the upstream's, or a tree in the way. */
export const syncFix = (failure: { readonly repo: string; readonly title: string; readonly reason: string; readonly push: boolean }): AgentFix => ({
    title: failure.title,
    repo: failure.repo,
    reason: failure.reason,
    goal: failure.push ? `${LEVEL_WITH_UPSTREAM} Then push, as the sync I pressed meant to.` : LEVEL_WITH_UPSTREAM,
    tree: `shared`,
});

// A remote that takes changes on this branch only through a pull request: GitHub's rulesets (GH013) and protected
// branches (GH006), GitLab's protected branches. Nothing a retry changes, and nothing to work around.
const PULL_REQUEST_ONLY = /GH013|GH006|repository rule violations|protected branch|must be made through a pull request|not allowed to push code to protected branches/iu;

/** Whether a refused push was refused by a rule that sends changes through a pull request. */
export const needsPullRequest = (run: Pick<PushRun, "reason" | "output">): boolean => PULL_REQUEST_ONLY.test(`${run.reason ?? ``}\n${run.output}`);

/** A push that settled refused: its hook, the remote, or a rule on the branch said no. */
export const pushFix = (title: string, run: PushRun): AgentFix => {
    const viaPullRequest = needsPullRequest(run);
    return {
        title,
        repo: run.repo,
        command: run.command,
        reason: run.reason,
        output: run.output,
        facts: viaPullRequest ? [`The remote takes changes on this branch only through a pull request.`] : [],
        goal: viaPullRequest
            ? `Do not try to get around the rule. Push my unpushed commits to a new branch named for what they do, open a pull request from it into the branch I was pushing to, and give me its link. ` +
              `Then put my local branch back level with its upstream, so the commits are not counted as unpushed twice; keep every commit reachable from the new branch.`
            : `Find out why the push was refused and deal with the cause. If this repository's own hook refused it, fix what the hook found, commit the fix, and push again. ` +
              `If the remote is ahead: ${LEVEL_WITH_UPSTREAM} Then push again. ` +
              `If a credential is missing or wrong, tell me which account to connect rather than guessing at one.`,
        tree: `shared`,
    };
};

/** A commit a hook (or git itself) refused, with the message still in the box. */
export const commitFix = (failure: { readonly repo: string; readonly title: string; readonly reason: string; readonly message: string }): AgentFix => ({
    title: failure.title,
    repo: failure.repo,
    reason: failure.reason,
    facts: failure.message.trim() === `` ? [] : [`The commit message I wrote: "${failure.message.trim()}"`],
    goal:
        `Find out what refused the commit and fix it. If a hook (pre-commit, commit-msg, a linter, a test) refused it, run it yourself, fix what it found in the staged changes, stage the fixes, and commit with my message, ` +
        `changing the message only if the hook refused the message itself. Never skip the hooks (no --no-verify).`,
    tree: `shared`,
});

/** A merge, rebase, cherry-pick or revert left in progress with conflicts, as git leaves one for a person to finish. */
export const operationFix = (failure: { readonly repo: string; readonly title: string; readonly operation: string; readonly conflicted: readonly string[] }): AgentFix => ({
    title: failure.title,
    repo: failure.repo,
    facts: [
        `A ${failure.operation} is in progress.`,
        ...(failure.conflicted.length === 0 ? [] : [`Conflicted files: ${failure.conflicted.map((path) => `\`${path}\``).join(`, `)}`]),
    ],
    goal:
        `Finish the ${failure.operation}: resolve each conflicted file by reading both sides and keeping what each side meant, run this repository's own checks over those files, ` +
        `stage them, and continue until the ${failure.operation} is done. Abort it only if I agree.`,
    tree: `shared`,
});

/** A repository git could not read at all. */
export const unreadableFix = (failure: { readonly repo: string; readonly title: string; readonly reason: string }): AgentFix => ({
    title: failure.title,
    repo: failure.repo,
    reason: failure.reason,
    goal: `Find out why git cannot read this repository (a lock left behind, a corrupt index, a broken ref, a missing object) and repair it without losing any commit or uncommitted change.`,
    tree: `shared`,
});
