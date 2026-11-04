import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import type { Services } from "../../../composition.js";
import { trackedBranch } from "../../../git/remote/remote.js";
import { matching } from "../../../rules/rules.js";

// The back-up rule (`push-landed`, 2026-11-04): what version-landed just committed is sent to each repository's remote,
// the way the Back up button sends it, so a sandbox set to land and save on its own can publish on its own too. Opt-in,
// and only ever after a commit a land made: work that landed uncommitted has nothing to push, and the owner's own commits
// travel with it only because a push sends the branch.
//
// It goes through the daemon's one push-run set (GitSlice.pushRuns): the repository's own pre-push hook runs, the push
// shows in the push terminal and on the Back up panel, and a refusal reaches the feed and the owner's devices as a
// pressed push's does. Never a force push and never a new branch on the remote: a repository whose checked-out branch
// tracks no upstream is left for the owner to publish once, by hand. A remote that moved ahead refuses the push; with
// `followOrigin` on, what it holds is merged in within minutes, and the next land's push goes through.

const PUSH_BUILTIN = "push-landed";

const pushesAt = (rules: readonly Rule[], repo: string): Rule | undefined =>
    matching(rules, "agent.landed", { repos: [repo] }).find((rule) => rule.action.kind === "builtin" && rule.action.name === PUSH_BUILTIN);

// Never throws: the commit it follows already stands, and a push that cannot start is the log's line. A land that commits
// while a push of the same repo is still going asks for one more after it (`again`), since that one may have read the
// branch before this commit.
export const pushLanded = async (
    services: Pick<Services, "agentWorktrees" | "pushRuns" | "ruleFirings" | "logger">,
    rules: readonly Rule[],
    repos: readonly string[],
): Promise<void> => {
    for (const repo of repos) {
        const rule = pushesAt(rules, repo);
        if (rule === undefined) {
            continue;
        }
        const dir = services.agentWorktrees.mainDir(repo);
        try {
            if ((await trackedBranch(dir)) === undefined) {
                services.logger.info({ repo }, "landed: not backed up, its branch tracks no remote branch");
                continue;
            }
            await services.pushRuns.start(repo, dir, { again: true });
            services.ruleFirings.stamp(rule.id, Date.now()).catch((error: Error) => services.logger.warn({ err: error }, "rule firing stamp failed"));
        } catch (error) {
            services.logger.warn({ err: error, repo }, "landed: the back-up push could not start");
        }
    }
};
