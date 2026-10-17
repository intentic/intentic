import type { CommitResult, OriginAgent, RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import { gitContract } from "@intentic/sandbox-contract/contracts/git.contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { AGENT_GIT_AUTHOR } from "../git-identity.js";
import { syncProjectExcludes } from "../workspace/layout/git-layout.js";
import { stageHold } from "./changes/index-preflight.js";
import type { IndexTargets } from "./changes/index-targets.js";
import { gitFailureReason } from "./git.js";
import { parsableMessage } from "./ops/commit-message.js";
import { createIndexRuns, IndexRunBusy } from "./ops/index-run.js";

// The routes that write the index for the Changes panel: the one-request stage and commit (kept for every caller that
// is not the panel: an agent's API, the settings save before a land), and the stage/commit runs the panel uses, which
// answer at once and are polled (ops/index-run.ts). Apart from git.routes.ts the way push-run.ts is, sharing its repo
// lock and scan through `IndexRouteDeps`.

export const gitImplementer = () => implement(gitContract).$context<OrpcContext>();
type GitImplementer = ReturnType<typeof gitImplementer>;

export interface IndexRouteDeps {
    readonly services: Services;
    // Resolves and heals a repo id, NOT_FOUND for an unknown one.
    readonly repoDir: (repo: string) => Promise<string>;
    readonly onRepo: <T>(repo: string, task: (dir: string) => Promise<T>) => Promise<T>;
    readonly whileCommitting: <T>(repo: string, run: () => Promise<T>) => Promise<T>;
    readonly invalidateScan: () => void;
    readonly targets: IndexTargets;
    readonly lightChip: (repo: string, dir: string, origin: string) => Promise<void>;
    // One repo's review row and the agents it names, for a commit's answer (git.routes.ts scanRepo / identifyOrigins).
    readonly scanRepo: (repo: string, dir: string) => Promise<RepoChanges | undefined>;
    readonly identifyOrigins: (repos: readonly RepoChanges[]) => Record<string, OriginAgent>;
}

export const indexRoutes = (i: GitImplementer, deps: IndexRouteDeps) => {
    const { services, targets } = deps;
    // Re-reads only the just-committed repo, inside the lock, instead of a full rescan: a land landing between commit
    // and read would describe a tree the commit didn't make. `scanRepo` takes no lock, so this isn't reentrant. A repo
    // with nothing left to show (the scan's own inclusion rule) comes back without `changes`; the client drops the row.
    const answer = async (repo: string, dir: string, committed: boolean): Promise<CommitResult> => {
        const changes = await deps.scanRepo(repo, dir);
        if (changes === undefined) {
            return { committed };
        }
        const originAgents = deps.identifyOrigins([changes]);
        return Object.keys(originAgents).length > 0 ? { committed, changes, originAgents } : { committed, changes };
    };
    // One run set per router (one per daemon), like the push runs; nothing else reaches it.
    const runs = createIndexRuns({
        logger: services.logger,
        perf: services.perf,
        onRepo: deps.onRepo,
        whileCommitting: deps.whileCommitting,
        invalidate: deps.invalidateScan,
        steps: {
            count: async (repo, dir, target) => {
                // Converged here as well as on every scan, so a run reached before the panel ever scanned this repo
                // still leaves a dependency dir out of what it stages.
                if (repo !== "root") {
                    await syncProjectExcludes(services.workspace.root, [repo]);
                }
                return targets.stagedBy(repo, dir, target);
            },
            hold: stageHold,
            stage: targets.stageTarget,
            commit: (dir, message, git) => services.git.commitIndex(dir, parsableMessage(message), AGENT_GIT_AUTHOR, git),
            answer,
        },
    });
    return {
        // One commit shape: `stage` (whole repo, scope, or paths) decides what enters the index; there is no
        // path-scoped `commit --only`. `stage` runs inside the repo lock so a land can't slip in between.
        // Marked committing before the lock: queued behind a land still counts as running to the user.
        commit: i.commit.handler(({ input }) =>
            deps.whileCommitting(input.repo, () =>
                deps.onRepo(input.repo, (dir) =>
                    services.perf.track("git.commit", { repo: input.repo }, async () => {
                        // Carries git's own refusal text back as a CONFLICT, not an opaque 500 with nothing to act on.
                        try {
                            // Stages first, then always commits the whole index (never a partial commit); one spelling
                            // avoids a --no-verify path that would skip hooks inconsistently.
                            if (input.stage !== undefined) {
                                await targets.stageTarget(input.repo, dir, input.stage);
                            }
                            // Repairs only spellings a conventional parser can't find a header in at all (`!` before the
                            // scope, no space after `:`); every other rule's verdict reaches the panel unchanged.
                            const committed = await services.git.commitIndex(dir, parsableMessage(input.message), AGENT_GIT_AUTHOR);
                            deps.invalidateScan();
                            return await answer(input.repo, dir, committed);
                        } catch (error) {
                            // The index can move even on failure (staging happens before the commit), so the view is
                            // stale regardless.
                            deps.invalidateScan();
                            throw new ORPCError("CONFLICT", { message: gitFailureReason(error, "git refused the commit") });
                        }
                    }),
                ),
            ),
        ),
        // Index-only: no checkpoint or history notification, since the worktree is untouched. A target means the whole
        // side, not just the rows a response could fit.
        stage: i.stage.handler(({ input }) =>
            deps.onRepo(input.repo, (dir) =>
                services.perf.track("git.stage", { repo: input.repo }, async () => {
                    await (input.chip === undefined ? targets.stageTarget(input.repo, dir, input) : deps.lightChip(input.repo, dir, input.chip));
                    deps.invalidateScan();
                    return { ok: true } as const;
                }),
            ),
        ),
        // Resolved before the run exists, so an unknown repo is a NOT_FOUND rather than a run that fails at once.
        indexRunStart: i.indexRunStart.handler(async ({ input: { repo, ...request } }) => {
            await deps.repoDir(repo);
            try {
                return runs.start(repo, request);
            } catch (error) {
                if (error instanceof IndexRunBusy) {
                    throw new ORPCError("CONFLICT", { message: error.message });
                }
                throw error;
            }
        }),
        indexRunState: i.indexRunState.handler(({ input }) => runs.state(input.repo)),
        // Cancelling a settled run is harmless: there is no git left to kill.
        indexRunCancel: i.indexRunCancel.handler(({ input }) => {
            runs.cancel(input.repo);
            return { ok: true as const };
        }),
    };
};
