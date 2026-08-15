import { choreById, PROBES } from "@intentic/sandbox-contract/chores";
import { choresContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { discoverRepos, isValidRepoId } from "../workspace/repo-discovery.js";
import { choreSignals } from "./chore-signals.js";

/* The maintenance routes. `list` is the whole surface's data: every repo's standing evidence in one read, because
 * the rail badge scans all of it on a timer and one request per repo per minute is the kind of poll that shows up
 * in a battery graph.
 *
 * WHAT IS NOT HERE is the point. There is no "run this chore" route: a chore run is an ordinary isolated fleet
 * agent (`POST /agent` with a derived conversation id), the same shape as an acceptance run or a documentation
 * generation, so the worktree, the live status, the cost, the transcript and the /agents/<id> page already exist.
 * A bespoke launcher here would be a second way to start a turn, kept in step with the first by hand.
 *
 * And no verdicts. The daemon serves measurements; @intentic/sandbox-contract/chores decides what is due, in the browser,
 * where both the panel and the badge run it. A daemon one image behind would otherwise be quietly arguing with
 * the browser about what needs doing — and this daemon is baked into an image the user updates when they feel
 * like it, so that is not a hypothetical. */

// "root" is the wire id for the workspace's own repository — the same spelling the git and health routes take —
// and the empty string is what the iq scope and the filesystem join call it. One translation, at the boundary.
const REPO_ROOT = "root";
const repoDir = (repo: string): string => (repo === REPO_ROOT ? "" : repo);
const repoId = (dir: string): string => (dir === "" ? REPO_ROOT : dir);

const knownRepo = async (services: Services, repo: string): Promise<boolean> =>
    repo === REPO_ROOT || (isValidRepoId(repo) && (await discoverRepos(services.workspace.root)).includes(repo));

export const createChoresRoutes = (services: Services) => {
    const i = implement(choresContract).$context<OrpcContext>();

    return {
        list: i.list.handler(async () => {
            const cache = await services.chores.probes();
            // Sequential rather than Promise.all: each entry calls into the RESIDENT iq engine, and fanning twenty
            // repos at it would make a background poll compete with the search the user is actually typing.
            const repos = [];
            for (const repo of [REPO_ROOT, ...(await discoverRepos(services.workspace.root))]) {
                repos.push({ repo, probes: Object.values(cache[repoDir(repo)] ?? {}), signals: await choreSignals(services, repoDir(repo)) });
            }
            return {
                repos,
                ledger: await services.chores.ledger(),
                // Read here rather than served from its own route: "what does this repo say" and "what is being
                // measured about it" are two halves of one answer, and a panel that had to ask twice would show
                // them disagreeing — a probe finishing between the two reads reads as both done and running.
                running: services.probeRunner.running().map(({ repo, id, askedAt, startedAt }) => ({ repo: repoId(repo), id, askedAt, startedAt })),
                // What is RUNNING, not what a manifest wishes for — an `engines` range is a wish, and the chore
                // that asks whether this sandbox is on a supported runtime has to read the answer off the process.
                node: process.version,
            };
        }),
        probe: i.probe.handler(async ({ input }) => {
            if (!(await knownRepo(services, input.repo))) {
                throw new ORPCError("NOT_FOUND", { message: `no repo named "${input.repo}"` });
            }
            if (!PROBES.some((spec) => spec.id === input.id)) {
                throw new ORPCError("BAD_REQUEST", { message: `no probe named "${input.id}"` });
            }
            // Deliberately not awaited: a jscpd sweep runs for minutes and the caller is a button, not a batch
            // job. The runner queues it, so this ack means "it will run", not "it might have" — and the next
            // `list` carries it as running, which is what the panel draws its progress on.
            void services.probeRunner.refresh(repoDir(input.repo), input.id).catch((error: unknown) => {
                services.logger.warn({ err: error, repo: input.repo, probe: input.id }, "chores: on-demand probe failed");
            });
            return { ok: true };
        }),
        record: i.record.handler(async ({ input }) => {
            if (!(await knownRepo(services, input.repo))) {
                throw new ORPCError("NOT_FOUND", { message: `no repo named "${input.repo}"` });
            }
            // A ledger row for a chore this build has never heard of is not a compatibility case worth carrying —
            // it would render as a run against a row the panel cannot show, which reads as data loss.
            if (choreById(input.chore) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `no chore named "${input.chore}"` });
            }
            await services.chores.recordLedger(input);
            return { ok: true };
        }),
    };
};
