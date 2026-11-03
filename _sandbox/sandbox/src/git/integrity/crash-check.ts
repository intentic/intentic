import { join } from "node:path";
import { cancellableGit, type GitRunner, onGitCorruption } from "@intentic/base/git";
import type { ManifestProblem } from "@intentic/sandbox-contract/schemas/system";
import type { Logger } from "pino";
import { recordManifestProblems } from "../../store/manifest/manifest-problems.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import { quarantineDir } from "./loose-objects.js";
import { type RepoRepair, repairRepo } from "./repo-repair.js";

// WHEN THE REPOSITORIES ARE CHECKED (2026-11-03). After a boot whose previous run left no clean exit (killed: the host
// lost power, the container was forced down; unknown: no marker at all), and whenever a git the daemon runs fails on
// damaged storage (`onGitCorruption`). Each workspace repository and the workspace's own history repo is read through
// once (repo-repair.ts), in the background and under one budget, so a boot never waits on it. A loss nothing could
// rebuild becomes one card on the Sandbox overview (the manifest-problems registry, filed on `/history/gits`), one row
// per repository; a later check that finds nothing clears it.

// The whole pass across every repository: long enough for a large monorepo's loose objects, short enough that a pass
// that hangs on a stuck disk ends.
const CHECK_BUDGET_MS = 10 * 60_000;
// A corruption seen again this soon after a pass is the same damage that pass already reported.
const CORRUPTION_RECHECK_MS = 5 * 60_000;

export interface IntegrityScope {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "info" | "warn" | "error">;
    // Test seam: the git a pass runs, given the pass's own budget.
    readonly gitFor?: (signal: AbortSignal) => GitRunner;
    readonly now?: () => number;
}

/** Where the card is filed: the volume's git dirs, reported as `/history/gits`. */
export const integrityCardPath = (historyRoot: string): string => join(historyRoot, "gits");

const plural = (count: number, one: string): string => `${String(count)} ${one}${count === 1 ? "" : "s"}`;

// The card row for one repository that lost something, or undefined when it lost nothing.
const lossProblem = (repair: RepoRepair, dir: string): ManifestProblem | undefined => {
    if (repair.missing.length === 0 && repair.refsLost.length === 0) {
        return undefined;
    }
    const name = repair.repo === "root" ? "the workspace's own history (root)" : `\`${repair.repo}\``;
    const lost = [
        repair.missing.length > 0 ? plural(repair.missing.length, "git object") : undefined,
        repair.refsLost.length > 0 ? `${plural(repair.refsLost.length, "ref")} (${repair.refsLost.join(", ")})` : undefined,
    ].filter((part) => part !== undefined);
    const saved = repair.rebuilt.length > 0 ? `; ${String(repair.rebuilt.length)} others were rebuilt from checkout files` : "";
    return {
        kind: "unreadable",
        reason: "io",
        detail: `After the sandbox stopped uncleanly, ${name} lost ${lost.join(" and ")} that nothing on this disk could rebuild${saved}`,
        fix: `Lands, diffs and logs that need them fail until they are back. If the repository has a remote, \`git -C ${dir} fetch --refetch\` brings back whatever was pushed; work that never left this sandbox has to be redone by the conversation that made it.${repair.commonDir === undefined ? "" : ` The damaged files are kept in ${quarantineDir(repair.commonDir, "<time>")} for a look by hand.`}`,
    };
};

const repoDirs = async (workspaceRoot: string): Promise<{ repo: string; dir: string }[]> => [
    { repo: "root", dir: workspaceRoot },
    ...(await discoverRepos(workspaceRoot)).map((repo) => ({ repo, dir: join(workspaceRoot, repo) })),
];

const logRepair = (logger: IntegrityScope["logger"], repair: RepoRepair, why: string): void => {
    const fields = { why, ...repair, quarantined: repair.quarantined.length, rebuilt: repair.rebuilt.length, missing: repair.missing.slice(0, 20) };
    if (repair.missing.length > 0 || repair.refsLost.length > 0) {
        logger.error(fields, "git integrity: a repository lost objects or refs nothing could rebuild");
    } else if (repair.quarantined.length > 0 || repair.refsRestored.length > 0) {
        logger.warn(fields, "git integrity: damaged git storage found and repaired");
    } else {
        logger.info({ why, repo: repair.repo, scanned: repair.scanned, incomplete: repair.incomplete }, "git integrity: repository read through, nothing damaged");
    }
};

/** One pass over every repository; files (or clears) the card and returns what each repository's check found. */
export const checkGitIntegrity = async (scope: IntegrityScope, why: string): Promise<RepoRepair[]> => {
    const now = scope.now ?? Date.now;
    const deadline = now() + CHECK_BUDGET_MS;
    const signal = AbortSignal.timeout(CHECK_BUDGET_MS);
    const git = (scope.gitFor ?? cancellableGit)(signal);
    const repairs: RepoRepair[] = [];
    const problems: ManifestProblem[] = [];
    for (const { repo, dir } of await repoDirs(scope.workspaceRoot)) {
        try {
            // one pass per repository, one after another: a crash damaged the disk they share
            const repair = await repairRepo(repo, dir, { git, deadline, now });
            repairs.push(repair);
            logRepair(scope.logger, repair, why);
            const problem = lossProblem(repair, dir);
            if (problem !== undefined) {
                problems.push(problem);
            }
        } catch (error) {
            scope.logger.warn({ err: error, repo, why }, "git integrity: the repository could not be checked");
        }
    }
    recordManifestProblems(integrityCardPath(scope.historyRoot), problems);
    return repairs;
};

let running: Promise<RepoRepair[]> | undefined;
let lastPassAt = Number.NEGATIVE_INFINITY;

// One pass at a time, and none again within CORRUPTION_RECHECK_MS of the last for a corruption sighting.
const startPass = (scope: IntegrityScope, why: string, force: boolean): Promise<RepoRepair[]> | undefined => {
    const now = (scope.now ?? Date.now)();
    if (running !== undefined || (!force && now - lastPassAt < CORRUPTION_RECHECK_MS)) {
        return undefined;
    }
    lastPassAt = now;
    running = checkGitIntegrity(scope, why).finally(() => {
        running = undefined;
        lastPassAt = (scope.now ?? Date.now)();
    });
    return running;
};

/**
 * Arms the checks for this daemon's life: a pass now when the previous run ended uncleanly, and a pass whenever a git
 * fails on damaged storage. Returns the boot's pass, for a test to await; production never waits on it.
 */
export const startGitIntegrity = (scope: IntegrityScope, uncleanBoot: boolean): Promise<RepoRepair[]> | undefined => {
    onGitCorruption((dir, said) => {
        const pass = startPass(scope, `a git failed on damaged storage in ${dir}`, false);
        if (pass !== undefined) {
            scope.logger.warn({ dir, said: said.slice(0, 500) }, "git integrity: git failed on damaged storage, checking every repository");
        }
    });
    return uncleanBoot ? startPass(scope, "the previous run ended uncleanly", true) : undefined;
};

/** Test seam: the pass under way, if any, to await. */
export const passInFlight = async (): Promise<void> => {
    await running;
};

/** Test seam: forgets the last pass and unhooks the runner. */
export const resetGitIntegrity = (): void => {
    running = undefined;
    lastPassAt = Number.NEGATIVE_INFINITY;
    onGitCorruption(undefined);
};
