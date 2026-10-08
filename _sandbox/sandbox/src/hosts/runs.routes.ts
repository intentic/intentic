import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { DEVICE_FEATURE_PROGRAMS, deviceSupports, RUN_TARGETS_FILE, RunTargetsFileSchema, runsContract, type RunTargetsList } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { createTerminalRunner, type TerminalRunner } from "../terminal/terminal-run.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";

// THE EDITOR'S "RUN ON <DEVICE>" (contracts/runs.contract.ts). A repository's targets are read off its own
// `.intentic/run.json` every time, like its checks: a commit or an agent can change the file between two openings. A run
// is the `devices run` command an agent would type, started in a terminal the owner watches; what lets that terminal act
// on the one computer it was started for is a grant minted for that computer, which ends with the run (device-door.ts).

type RunsServices = Pick<Services, "capabilities" | "hostHub" | "runGrants" | "workspace" | "logger">;

const repoDir = (root: string, repo: string): string => (repo === "root" ? root : join(root, repo));
const filePath = (repo: string): string => (repo === "root" ? RUN_TARGETS_FILE : `${repo}/${RUN_TARGETS_FILE}`);

const readRepo = async (root: string, repo: string): Promise<RunTargetsList["repos"][number] | undefined> => {
    let text: string | undefined;
    try {
        text = await readFile(join(repoDir(root, repo), RUN_TARGETS_FILE), "utf8").catch(undefinedIfMissing);
    } catch (error) {
        return { repo, path: filePath(repo), targets: [], error: `the file could not be read (${errnoCode(error) ?? errorMessage(error)})` };
    }
    if (text === undefined) {
        return undefined;
    }
    try {
        return { repo, path: filePath(repo), targets: RunTargetsFileSchema.parse(JSON.parse(text)).targets };
    } catch (error) {
        return { repo, path: filePath(repo), targets: [], error: errorMessage(error) };
    }
};

export const readRunTargets = async (root: string): Promise<RunTargetsList["repos"]> => {
    const repos = ["root", ...(await discoverRepos(root))];
    const read = await Promise.all(repos.map((repo) => readRepo(root, repo)));
    return read.filter((entry) => entry !== undefined);
};

// A tmux session name from what the run is: letters, digits and dashes, under the `job-` prefix the terminals panel
// shows as a watchable job and the boot sweep clears.
export const runSession = (repo: string, target: string, device: string): string =>
    `job-run-${[repo, target, device].join("-").replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 60)}`;

export const createRunsRoutes = (services: RunsServices, runner: TerminalRunner = createTerminalRunner()) => {
    const i = implement(runsContract).$context<OrpcContext>();
    return {
        targets: i.targets.handler(async () => {
            const [repos, cards] = await Promise.all([readRunTargets(services.workspace.root), services.capabilities.list()]);
            const devices = cards
                .filter((card) => card.kind === "device")
                .map((card) => {
                    const state = services.hostHub.state(card.id);
                    return {
                        id: card.id,
                        online: state.online,
                        programs: state.online && deviceSupports(state.facts, DEVICE_FEATURE_PROGRAMS),
                        allowed: card.kind === "device" && card.config.programs === "on",
                    };
                });
            return { repos, devices };
        }),
        start: i.start.handler(async ({ input }) => {
            const declared = await readRepo(services.workspace.root, input.repo);
            const target = declared?.targets.find((entry) => entry.name === input.target);
            if (target === undefined) {
                throw new ORPCError("NOT_FOUND", {
                    message: declared?.error ?? `${input.repo} declares no run target called "${input.target}" in ${RUN_TARGETS_FILE}`,
                });
            }
            const state = services.hostHub.state(input.device);
            if (!state.online) {
                throw new ORPCError("CONFLICT", { message: `"${input.device}" is not connected right now` });
            }
            if (!deviceSupports(state.facts, DEVICE_FEATURE_PROGRAMS)) {
                throw new ORPCError("CONFLICT", { message: `the agent on "${input.device}" is too old to run programs: update it there first` });
            }
            const session = runSession(input.repo, input.target, input.device);
            if (runner.running(session)) {
                return { session };
            }
            const grant = services.runGrants.mint(input.device);
            const command = ["devices", "run", input.target, "--device", input.device].map(shellQuote).join(" ");
            const started = new Promise<void>((done) => {
                void runner
                    .tryRun(session, command, {
                        cwd: repoDir(services.workspace.root, input.repo),
                        window: input.target,
                        env: { INTENTIC_RUN_GRANT: grant },
                        onStarted: done,
                    })
                    .catch((error: unknown) => services.logger.warn({ err: errorMessage(error), session }, "run on device: the terminal job failed"))
                    // The grant lasts as long as the run: a run that ended cannot act on the computer after it.
                    .finally(() => {
                        services.runGrants.revoke(grant);
                        done();
                    });
            });
            await started;
            return { session };
        }),
    };
};
