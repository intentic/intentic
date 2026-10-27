import type { AgentChanges, AgentConflicts, AgentHistory, AgentRepoChanges, ScratchPath } from "@intentic/sandbox-contract/schemas/git/git";
import { refuse } from "@intentic/contract-serve";
import { REVIEW_AGENT_ID } from "../../fixture/fleet";
import { agentChanges } from "../../fixture/workspace";
import { demoQuiet } from "../../mode";
import { OWNER, roster, STARTED_AT } from "./roster";

// What the board's review reads on top of the fixture's recorded deltas (fixture/workspace.ts): the scratch a copy holds
// and what became of it, work settled by hand after a refused land, and a conversation thrown away. The daemon reads
// these off the live copy and its own registry; here they are this page load's own record of the presses.

// The soft-deletes agent's copy, as the daemon's scratch reading would judge it: the browser tool's capture folder, a
// dev server's log and a dump it took before the migration. Each directory names the files it stands for, so including
// it carries them as rows of their own.
interface DemoScratch extends ScratchPath {
    readonly inside?: readonly string[];
}
const SCRATCH = new Map<string, Map<string, DemoScratch[]>>([
    [
        REVIEW_AGENT_ID,
        new Map([
            [
                `web`,
                [
                    {
                        path: `.playwright-mcp/`,
                        reason: `hidden`,
                        files: 3,
                        bytes: 412_300,
                        inside: [`.playwright-mcp/users-before.png`, `.playwright-mcp/users-after.png`, `.playwright-mcp/console.log`],
                    },
                    { path: `vite-debug.log`, reason: `byproduct`, files: 1, bytes: 18_240 },
                ],
            ],
            [`api`, [{ path: `users-before-migration.sql.bak`, reason: `byproduct`, files: 1, bytes: 2_310_000 }]],
        ]),
    ],
]);

// Rows a press carried into the work: each scratch file included, under its repository.
const included = new Map<string, Map<string, string[]>>();
// Work brought in by hand after a refused land (the review's "Already merged"), when it was settled.
const settled = new Map<string, number>();
// Conversations thrown away: their copies and branches are gone, so a stale review reads as nothing left.
const discarded = new Set<string>();

const card = (id: string) => roster.agents.find((agent) => agent.id === id);

// Refused as the daemon refuses every write to a copy: a turn is writing to it now.
export const refuseWhileRunning = (id: string): void => {
    if (card(id)?.status === `running`) {
        refuse(`A turn is running in this conversation. Wait for it to finish, or stop it first.`, 409);
    }
};

const scratchOf = (id: string): AgentChanges[`scratch`] => {
    const repos = [...(SCRATCH.get(id) ?? new Map<string, DemoScratch[]>())].filter(([, paths]) => paths.length > 0);
    return repos.length === 0 ? undefined : repos.map(([repo, paths]) => ({ repo, paths: paths.map(({ inside: _inside, ...path }) => path) }));
};

const withIncluded = (id: string, repos: AgentRepoChanges[]): AgentRepoChanges[] =>
    repos.map((repo) => {
        const added = included.get(id)?.get(repo.repo) ?? [];
        return added.length === 0
            ? repo
            : { ...repo, changes: [...repo.changes, ...added.map((path) => ({ path, status: `added` as const, landed: false }))] };
    });

/** The review as this page load's presses left it: scratch listed or carried, settled work absorbed, a discard empty. */
export const reviewOf = (id: string): AgentChanges => {
    if (discarded.has(id)) {
        return { repos: [], absorbed: 0 };
    }
    const recorded = agentChanges(id);
    if (settled.has(id)) {
        const { conflicts: _answered, ...rest } = recorded;
        const files = recorded.repos.reduce((sum, repo) => sum + repo.changes.length, 0);
        return { ...rest, repos: [], absorbed: files };
    }
    const changes: AgentChanges = { ...recorded, repos: withIncluded(id, recorded.repos) };
    const scratch = demoQuiet() ? undefined : scratchOf(id);
    return scratch === undefined ? changes : { ...changes, scratch };
};

export const conflictsOf = (id: string): AgentConflicts => {
    const { conflicts } = reviewOf(id);
    return conflicts === undefined ? {} : { conflicts };
};

// Takes the named scratch out of the copy's listing, refusing a path that is not scratch right now, as the daemon does.
const takeScratch = (id: string, repo: string, paths: readonly string[]): DemoScratch[] => {
    refuseWhileRunning(id);
    const held = SCRATCH.get(id)?.get(repo) ?? [];
    const taken = held.filter((entry) => paths.includes(entry.path));
    if (taken.length !== paths.length) {
        return refuse(`That is not scratch in this conversation's copy any more. Reload the review.`, 400);
    }
    SCRATCH.get(id)?.set(
        repo,
        held.filter((entry) => !taken.includes(entry)),
    );
    return taken;
};

export const includeScratch = (id: string, repo: string, paths: readonly string[]): void => {
    const taken = takeScratch(id, repo, paths);
    const byRepo = included.get(id) ?? new Map<string, string[]>();
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), ...taken.flatMap((entry) => entry.inside ?? [entry.path])]);
    included.set(id, byRepo);
};

export const deleteScratch = (id: string, repo: string, paths: readonly string[]): void => {
    takeScratch(id, repo, paths);
};

export const settleReview = (id: string, at: number): void => {
    settled.set(id, at);
};

export const discardReview = (id: string): void => {
    discarded.add(id);
};

// The settled work as the main line now holds it: one commit of the owner's carrying every file the land refused.
export const historyOf = (id: string): AgentHistory => {
    const at = settled.get(id);
    if (at === undefined) {
        return { repos: [], unaccounted: 0 };
    }
    const title = card(id)?.title ?? `this conversation's work`;
    return {
        repos: agentChanges(id).repos.map((repo, index) => {
            const sha = `${(at + index).toString(16).padStart(12, `0`)}a1c9e4d7b2f05e8c`.slice(0, 40);
            return {
                repo: repo.repo,
                commits: [
                    {
                        sha,
                        short: sha.slice(0, 7),
                        subject: `Bring in ${title.charAt(0).toLowerCase()}${title.slice(1)} by hand`,
                        author: OWNER.name ?? OWNER.email,
                        at: Math.max(at, STARTED_AT),
                        changes: repo.changes.map(({ landed: _landed, code: _code, ...change }) => change),
                    },
                ],
                modules: repo.modules ?? [],
            };
        }),
        unaccounted: 0,
    };
};
