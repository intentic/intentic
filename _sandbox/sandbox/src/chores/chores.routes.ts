import { choreById, PROBES } from "@intentic/sandbox-contract/chores";
import { choresContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { discoverRepos, isValidRepoId } from "../workspace/layout/repo-discovery.js";
import { choreSignals } from "./chore-signals.js";

// `list` returns every repo's evidence in one read, since the rail badge polls all of it on a timer. No run-a-chore
// route: a chore run is an ordinary isolated agent turn (POST /agent). No verdicts either: the daemon only serves
// measurements, @intentic/sandbox-contract/chores decides what's due, in the browser.

// "root" is the wire id for the workspace's own repo; the iq scope and filesystem call it the empty string.
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
            // Sequential, not Promise.all: fanning every repo at the resident iq engine would compete with live search.
            const repos = [];
            for (const repo of [REPO_ROOT, ...(await discoverRepos(services.workspace.root))]) {
                repos.push({ repo, probes: Object.values(cache[repoDir(repo)] ?? {}), signals: await choreSignals(services, repoDir(repo)) });
            }
            return {
                repos,
                ledger: await services.chores.ledger(),
                // Read here, not its own route, so a probe finishing mid-read can't show as both done and running.
                running: services.probeRunner.running().map(({ repo, id, askedAt, startedAt }) => ({ repo: repoId(repo), id, askedAt, startedAt })),
                // Node's actual running version, not a manifest's `engines` wish; the chore checks the real runtime.
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
            // Not awaited: refresh queues the sweep and returns; `list` shows it as running right away.
            void services.probeRunner.refresh(repoDir(input.repo), input.id).catch((error: unknown) => {
                services.logger.warn({ err: error, repo: input.repo, probe: input.id }, "chores: on-demand probe failed");
            });
            return { ok: true };
        }),
        record: i.record.handler(async ({ input }) => {
            if (!(await knownRepo(services, input.repo))) {
                throw new ORPCError("NOT_FOUND", { message: `no repo named "${input.repo}"` });
            }
            // An unknown chore id would render as a ledger row the panel can't show, indistinguishable from data loss.
            if (choreById(input.chore) === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: `no chore named "${input.chore}"` });
            }
            await services.chores.recordLedger(input);
            return { ok: true };
        }),
    };
};
