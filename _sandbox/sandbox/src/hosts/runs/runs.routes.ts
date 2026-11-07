import { errorMessage } from "@intentic/base/errors";
import { DEVICE_FEATURE_PROGRAMS, deviceSupports } from "@intentic/sandbox-contract/schemas/hosts";
import { RUN_TARGETS_FILE, type RunStart, type RunTargetsList, type RunTerminal } from "@intentic/sandbox-contract/schemas/run-targets";
import { runsContract } from "@intentic/sandbox-contract/contracts/runs.contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import { discoverRepos, ROOT_REPO, repoDirOf } from "../../workspace/layout/repo-discovery.js";
import { readRunFile } from "../../workspace/layout/run-file.js";

// THE EDITOR'S "RUN ON <DEVICE>" (contracts/runs.contract.ts). A repository's targets are read off its own
// `.intentic/run.json` every time, like its checks: a commit or an agent can change the file between two openings. A run
// is the `devices run` command an agent would type, started in a terminal the owner watches; what lets that terminal act
// on the one computer it was started for is a grant minted for that computer, which ends with the run (device-door.ts).

type RunsServices = Pick<Services, "capabilities" | "hostHub" | "runGrants" | "deviceRuns" | "workspace" | "logger" | "terminalRun">;

// A run's terminal while it lasts: what it runs, what ends it (Stop, or Run pressed again), and its end.
interface LiveRun {
    readonly input: RunStart;
    readonly abort: AbortController;
    readonly ended: Promise<void>;
}

export const readRunTargets = async (root: string): Promise<RunTargetsList["repos"]> => {
    const repos = [ROOT_REPO, ...(await discoverRepos(root))];
    const read = await Promise.all(repos.map((repo) => readRunFile(root, repo)));
    return read.filter((entry) => entry !== undefined);
};

// A tmux session name from what the run is: letters, digits and dashes, under the `job-` prefix the terminals panel
// shows as a watchable job and the boot sweep clears.
export const runSession = (repo: string, target: string, device: string): string =>
    `job-run-${[repo, target, device]
        .join("-")
        .replace(/[^A-Za-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 60)}`;

// The computer named, connected and new enough to run programs, or the refusal saying which it is not.
const assertRunnable = (services: RunsServices, device: string): void => {
    const state = services.hostHub.state(device);
    if (!state.online) {
        throw new ORPCError("CONFLICT", { message: `"${device}" is not connected right now` });
    }
    if (!deviceSupports(state.facts, DEVICE_FEATURE_PROGRAMS)) {
        throw new ORPCError("CONFLICT", { message: `the agent on "${device}" is too old to run programs: update it there first` });
    }
};

// Who the computer records a stop from the Run view as coming from ("stopped by the Run view's Stop").
const RUN_VIEW_STOP = "the Run view's Stop";

// The computer's refusal, in its own words, as the editor's error.
const refusal = (message: string): ORPCError<"CONFLICT", unknown> => new ORPCError("CONFLICT", { message });

// The terminals runs happen in, one per target and computer: started holding a grant for that computer, and ended by
// Stop or by Run pressed again.
const createRunTerminals = (services: RunsServices, runner: TerminalRunner) => {
    const live = new Map<string, LiveRun>();

    // Ends a run's terminal: `devices run` building, pushing or following its program. The program itself is the
    // computer's to stop (deviceRuns); a terminal still building has none yet.
    const end = async (session: string): Promise<void> => {
        const held = live.get(session);
        if (held !== undefined) {
            held.abort.abort();
            await held.ended;
        }
    };

    // Opens the target's terminal on `devices <args>`, holding a grant for its one computer while it lasts.
    const open = async (input: RunStart, session: string, args: readonly string[]): Promise<string> => {
        const grant = services.runGrants.mint(input.device);
        const command = ["devices", ...args].map(shellQuote).join(" ");
        const abort = new AbortController();
        await new Promise<void>((done) => {
            const ended = runner
                .tryRun(session, command, {
                    cwd: repoDirOf(services.workspace.root, input.repo),
                    window: input.target,
                    env: { INTENTIC_RUN_GRANT: grant, INTENTIC_RUN_REPO: input.repo },
                    signal: abort.signal,
                    onStarted: done,
                })
                .then(() => undefined)
                .catch((error: Error) => {
                    if (!abort.signal.aborted) {
                        services.logger.warn({ err: errorMessage(error), session }, "run on device: the terminal job failed");
                    }
                })
                // The grant lasts as long as the run: a run that ended cannot act on the computer after it.
                .finally(() => {
                    services.runGrants.revoke(grant);
                    if (live.get(session)?.abort === abort) {
                        live.delete(session);
                    }
                    done();
                });
            live.set(session, { input, abort, ended });
        });
        return session;
    };

    const start = async (input: RunStart): Promise<string> => {
        const session = runSession(input.repo, input.target, input.device);
        // Run pressed again is a restart: the terminal still building or following the last run ends, and the new
        // `devices run` stops the program it left once its own build is ready (so a failed build leaves it going).
        await end(session);
        // Attached: the terminal follows the program's output, Ctrl+C in it stops the program, Ctrl+D leaves it.
        return await open(input, session, ["run", input.target, "--device", input.device, "--attach"]);
    };

    // A program already running there, followed again (`devices attach`): the run's terminal was closed, or left with
    // Ctrl+D. A terminal of the target's still open is that program's already, or the build that replaces it.
    const attach = async (input: RunStart, id: string): Promise<string> => {
        const session = runSession(input.repo, input.target, input.device);
        if (live.has(session)) {
            return session;
        }
        return await open(input, session, ["attach", id, "--device", input.device]);
    };

    // The terminals still open for one computer's runs, for the Run view to reopen.
    const on = (device: string): RunTerminal[] =>
        [...live.entries()]
            .filter(([, held]) => held.input.device === device)
            .map(([session, held]) => ({ repo: held.input.repo, target: held.input.target, session }));

    return { start, attach, end, on };
};

// The daemon's one runner by default: the terminals list reads it to say a job terminal still runs (so the editor keeps
// its tab), and the job reaper to keep it.
export const createRunsRoutes = (services: RunsServices, runner: TerminalRunner = services.terminalRun) => {
    const i = implement(runsContract).$context<OrpcContext>();
    const terminals = createRunTerminals(services, runner);

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
            const declared = await readRunFile(services.workspace.root, input.repo);
            const target = declared?.targets.find((entry) => entry.name === input.target);
            if (target === undefined) {
                throw new ORPCError("NOT_FOUND", {
                    message: declared?.error ?? `${input.repo} declares no run target called "${input.target}" in ${RUN_TARGETS_FILE}`,
                });
            }
            if (target.artifact === undefined) {
                throw new ORPCError("BAD_REQUEST", {
                    message: `"${input.target}" runs in the sandbox only: it declares a command and nothing to carry to a computer`,
                });
            }
            assertRunnable(services, input.device);
            return { session: await terminals.start(input) };
        }),
        attach: i.attach.handler(async ({ input }) => {
            assertRunnable(services, input.device);
            return { session: await terminals.attach({ repo: input.repo, target: input.target, device: input.device }, input.id) };
        }),
        active: i.active.handler(async ({ input }) => {
            const open = terminals.on(input.device);
            const state = services.hostHub.state(input.device);
            if (!state.online || !deviceSupports(state.facts, DEVICE_FEATURE_PROGRAMS)) {
                return { runs: [], terminals: open };
            }
            try {
                return { runs: await services.deviceRuns.list(input.device), terminals: open };
            } catch (error) {
                services.logger.warn({ err: errorMessage(error), device: input.device }, "runs on device: the computer did not list them");
                // Said, not hidden: an empty list would read as "nothing runs there", which nobody checked.
                return { runs: [], terminals: open, error: errorMessage(error) };
            }
        }),
        stop: i.stop.handler(async ({ input }) => {
            await terminals.end(runSession(input.repo, input.target, input.device));
            assertRunnable(services, input.device);
            try {
                if (input.id !== undefined) {
                    return { stopped: [{ id: input.id, text: await services.deviceRuns.stop(input.device, input.id, { by: RUN_VIEW_STOP }) }] };
                }
                return { stopped: await services.deviceRuns.stopNamed(input.device, input.target, RUN_VIEW_STOP) };
            } catch (error) {
                throw refusal(errorMessage(error));
            }
        }),
        output: i.output.handler(async ({ input }) => {
            assertRunnable(services, input.device);
            try {
                return await services.deviceRuns.output(input.device, input.id, { since: input.since, lines: input.lines });
            } catch (error) {
                throw refusal(errorMessage(error));
            }
        }),
    };
};
