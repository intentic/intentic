import { keyedLock } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Disposable, ExtensionServerApi, ServerActivation, ToolDefinition } from "@intentic/extension-api";
import type { CiFeedEvent, PipelineRun } from "@intentic/sandbox-contract/schemas/ci";
import { boardRoute } from "./board.js";
import { daemonOf } from "./daemon.js";
import { ciLogsRoot } from "./job-logs.js";
import { type Logger, loggerOf, type LogFields } from "./log.js";
import { fixerSettled, heardCi, resetMainFixer, resumeMainFixer, taken } from "./main-fixer.js";
import { mainKnown } from "./main-known.js";
import { ownerStepSettled } from "./owner-steps.js";
import type { Repair } from "./repair.js";
import { repairStore } from "./repair-store.js";

/* THE PIPELINES EXTENSION'S BACKEND (2026-11-26): main's one fix agent and the Pipelines board's backend, the daemon's ci/
   until then. It hears CI on its own event stream (`ci`), and its fix agents' runs ending (`run`); keeps its streaks in its
   own record, which it takes over from the daemon once (POST /ci/repair/hand-over); claims main lines' failures while the
   owner's `autoRepair` is on, so no `ci` automation listening on every branch starts a second agent on main
   (POST /ci/main-lines/claim); holds work while a run's failures wait to be handed over; serves the board's routes under
   its namespace; and answers `agents ci` with its `main_failures` tool, which the turn's shell reaches through the
   daemon's tools door. CI ingestion (the webhook, the poller, the forge clients, the feed) stays the daemon's. */

// Runs the feed told of, kept for what a job's own frame does not say of its run; the newest this many.
const RUNS_KEPT = 500;
const AUTO_REPAIR = "autoRepair";

// The tool `agents ci` calls (bin/agents, through POST /tools/pipelines): what main's CI is known to fail on, its rows and
// words, and what the sandbox's own test runs saw fail at main.
export const MAIN_FAILURES_TOOL = "main_failures";

const repoOf = (event: CiFeedEvent): string => (event.kind === "run" ? event.run.repo : event.repo);

// Work that runs on its own clock: a failure is logged, never thrown at the stream or the route that set it going.
const inBackground = (logger: Logger, message: string, work: () => Promise<void>, fields: LogFields = {}): void => {
    void (async () => {
        try {
            await work();
        } catch (error) {
            logger.warn({ ...fields, err: errorMessage(error) }, message);
        }
    })();
};

// The owner's switch, as the settings say it now; on until they say otherwise, as the setting's default is.
const repairsOn = (api: Pick<ExtensionServerApi, "settings">): Promise<boolean> =>
    api.settings.get().then(
        (values) => values[AUTO_REPAIR] !== false,
        () => true,
    );

// The tools every turn gets from this extension: what main's CI is known to fail on.
const toolsOf = (repair: Repair): readonly ToolDefinition[] => [
    {
        name: MAIN_FAILURES_TOOL,
        description:
            "What main's CI is known to fail on now, from the runs this sandbox already heard (no forge is asked): each failing job with the run, commit and time it was read, and the failing tests and errors its log named; then what this sandbox's own test runs on clean trees at main commits saw fail. Ask it BEFORE re-running main to tell whether a failure is yours. Answers JSON: `text`, the words, and the rows.",
        inputSchema: { type: "object", properties: {} },
        effect: "read",
        call: async () => JSON.stringify(await mainKnown(repair)),
    },
];

// Every run the feed told of, newest kept: what a job's own frame does not say of its run (what set it off).
const runMemory = () => {
    const runs = new Map<string, PipelineRun>();
    return {
        known: (repo: string, runId: number): PipelineRun | undefined => runs.get(`${repo}\n${runId}`),
        remember: (event: CiFeedEvent): void => {
            if (event.kind !== "run") {
                return;
            }
            runs.set(`${event.run.repo}\n${event.run.runId}`, event.run);
            for (const key of [...runs.keys()].slice(0, Math.max(0, runs.size - RUNS_KEPT))) {
                runs.delete(key);
            }
        },
    };
};

// What main's fix agent hears: CI, one repository's news in the order it was heard, each after the last is done with
// (whether a run fixed or broke a streak is read against what the run before it left), a gap caught up from the forge;
// its fix agents' runs ending; and the owner's switch, which claims main lines or lets them go.
const listen = (api: ExtensionServerApi, repair: Repair, memory: ReturnType<typeof runMemory>, switched: () => void): Disposable[] => {
    const inOrder = keyedLock<string>();
    const { logger } = repair;
    return [
        api.events.onCi((events) => {
            if (events.length === 0) {
                inBackground(logger, "ci repair: catching up after a gap failed", () => resumeMainFixer(repair));
                return;
            }
            for (const event of events) {
                memory.remember(event);
                inBackground(
                    logger,
                    "ci repair: what CI said could not be read",
                    () =>
                        inOrder(repoOf(event), async () => {
                            await heardCi(repair, event);
                            await taken(repair, event);
                        }),
                    { repo: repoOf(event) },
                );
            }
        }),
        api.events.onRunSettled((settled) => {
            inBackground(logger, "ci repair: a settled turn could not be read", () => fixerSettled(repair, settled));
            inBackground(logger, "ci fix: a settled turn's owner step could not be kept", () => ownerStepSettled(repair, settled));
        }),
        api.settings.onDidChange((keys) => {
            if (keys.length === 0 || keys.includes(AUTO_REPAIR)) {
                switched();
            }
        }),
    ];
};

export const activateServer = (api: ExtensionServerApi): ServerActivation => {
    const logger = loggerOf(api.log);
    const daemon = daemonOf(api.daemon);
    const memory = runMemory();
    let repairing = repairsOn(api);
    // What went wrong with getting going, said on the Extensions row.
    let trouble: string | undefined;
    const repair: Repair = {
        daemon,
        store: repairStore(api),
        logger,
        activity: (row) => api.activity.append(row),
        autoRepair: () => repairing,
        knownRun: memory.known,
        hold: (label) => api.work.hold(label),
        logsRoot: ciLogsRoot(),
    };
    // Main lines' failures are this extension's while repairs are on, and every `ci` automation's while they are off.
    const claim = async (): Promise<void> => {
        const on = await repairing;
        await daemon.claimMainLines(on);
        logger.info({ claimed: on }, "ci repair: main lines' failures claimed as repairs are");
    };
    const listening = listen(api, repair, memory, () => {
        repairing = repairsOn(api);
        inBackground(logger, "ci repair: the claim on main lines could not be changed", claim);
    });
    api.routes.mount((request) => boardRoute(repair, request, api.caller(request)));
    api.tools.serve(() => toolsOf(repair));
    // Taken over once, then caught up with what main did while nothing was heard.
    void (async () => {
        try {
            if (await repair.store.takeOver(() => daemon.handOverRepair())) {
                logger.info({}, "ci repair: what the daemon kept of main's repair was taken over");
            }
            await claim();
            await resumeMainFixer(repair);
        } catch (error) {
            trouble = `main's repair could not get going: ${errorMessage(error)}`;
            logger.warn({ err: errorMessage(error) }, "ci repair: the backend could not take over or catch up");
        }
    })();
    return {
        deactivate: () => {
            for (const each of listening) {
                each.dispose();
            }
            resetMainFixer();
        },
        health: () => (trouble === undefined ? { state: "ok" } : { state: "degraded", detail: trouble }),
    };
};
