import type { Rule } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { commitOnly } from "../../git/changes/changes-index.js";
import { AGENT_GIT_AUTHOR } from "../../git-identity.js";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import { standing } from "../../rules/rules.js";
import { describeLanding } from "./landed-subject.js";

// The `version-landed` built-in at `agent.landed`: keeps the main tree committed for a person who never commits.
// Worktrees are cut from HEAD (worktrees.ts `snapshot`) and the pre-turn sync rebases onto HEAD, so a land left
// uncommitted is invisible to every later agent. Two moments close that: right after a land, its claimed paths are
// committed under the subject drafted for it; right before an isolated turn starts, whatever else is dirty in the
// main tree (the owner's own edits) is committed too, so the assistant reads what its owner wrote.

const VERSION_BUILTIN = "version-landed";

// The standing rule, if the owner has one; a disabled or absent rule leaves every commit to the owner.
export const versionRuleOf = (rules: readonly Rule[]): Rule | undefined =>
    standing(rules, "agent.landed").find((rule) => rule.action.kind === "builtin" && rule.action.name === VERSION_BUILTIN);

// The subject an owner would read in `git log` when the drafting model wrote nothing (disabled, refused, or the land
// left nothing to describe): the conversation's own title, which at least names the ask.
const fallbackSubject = (title: string | undefined, id: string): string => `Agent: ${title ?? id}`;

// Commits one landing's claimed paths in each repo it spans, under the repo lock so a land or a discard queues behind
// it. Returns the repos it committed in.
const commitClaim = async (services: Services, id: string): Promise<string[]> => {
    const entry = services.agents.entry(id);
    if (entry === undefined) {
        return [];
    }
    const subject = entry.landedSubject ?? fallbackSubject(entry.title, id);
    const committed: string[] = [];
    for (const composed of entry.repos) {
        const dir = services.agentWorktrees.mainDir(composed.repo);
        // The claim is read off git (origins.ts): the paths this agent's landing put in the tree that history has
        // not absorbed yet, which is exactly the set a commit should carry.
        const origins = await services.agentOrigins.forRepo(composed.repo, dir);
        const paths = Object.entries(origins)
            .filter(([, ids]) => ids.includes(id))
            .map(([path]) => path);
        if (paths.length === 0) {
            continue;
        }
        const did = await services.agentWorktrees.withRepoLock(composed.repo, () => commitOnly(dir, paths, subject, AGENT_GIT_AUTHOR));
        if (did) {
            committed.push(composed.repo);
        }
    }
    return committed;
};

// What happens to a landing once it is in the tree: the subject is drafted first, then, with the rule standing, the
// claim is committed under it. A draft that fails is already told on its report; it must not cost the commit, which
// falls back to the title.
export const settleLanding = async (services: Services, id: string): Promise<void> => {
    const { rules } = await services.sandboxSettings.get();
    const rule = versionRuleOf(rules);
    await describeLanding(services, id).catch((error: unknown) => services.logger.debug({ err: error, agent: id }, "landed subject: draft failed"));
    if (rule === undefined) {
        return;
    }
    const committed = await commitClaim(services, id);
    if (committed.length === 0) {
        return;
    }
    // The commit itself moves HEAD, which the daemon's ref watcher already announces to every panel; only the firing
    // needs recording here.
    services.ruleFirings.stamp(rule.id, Date.now()).catch((error: unknown) => services.logger.warn({ err: error }, "rule firing stamp failed"));
    services.logger.info({ agent: id, repos: committed }, "landed: versioned");
};

// Never throws and never awaited on a land's own response: a land that already succeeded must not fail on its
// bookkeeping.
export const settleLandingInBackground = (services: Services, id: string): void => {
    void settleLanding(services, id).catch((error: unknown) => services.logger.warn({ err: error, agent: id }, "landed: settling failed"));
};

// The subject of the owner's own remainder, committed before an isolated turn reads the tree.
const REMAINDER_SUBJECT = "Your edits";

// Commits whatever is dirty in the main tree of each repo a turn is about to span, when the version rule stands;
// otherwise nothing, since an uncommitted tree is the developer's review boundary. Best-effort: a repo that refuses
// stays as it was and the turn goes on without the owner's latest edits, which is what happened before this existed.
export const versionMainTree = async (services: Services, repos: readonly string[]): Promise<string[]> => {
    const { rules } = await services.sandboxSettings.get();
    if (versionRuleOf(rules) === undefined) {
        return [];
    }
    const committed: string[] = [];
    for (const repo of repos) {
        try {
            const did = await services.agentWorktrees.withRepoLock(repo, () =>
                commitWorktreeRemainder(repo, services.agentWorktrees.mainDir(repo), REMAINDER_SUBJECT),
            );
            if (did) {
                committed.push(repo);
            }
        } catch (error) {
            services.logger.warn({ err: error, repo }, "version: committing the main tree's remainder failed");
        }
    }
    return committed;
};
