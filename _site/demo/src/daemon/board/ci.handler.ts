import { type RawContext, refuse } from "@intentic/contract-serve";
import {
    type CiFixParam,
    CiFixParamSchema,
    type CiForgetParam,
    CiForgetParamSchema,
    CiRunParamSchema,
} from "@intentic/sandbox-contract/schemas/ci";
import { ciFixTitle } from "@intentic/sandbox-contract/ids/conversation-ids";
import { cancelCi, ciJobs, ciRunsResponse, dispatchCi, forgetCi, rerunCi } from "../../fixture/ci";
import { demoMode, demoQuiet } from "../../mode";
import { pushRuntime } from "../runtimePush";
import { putCard, workCard } from "./workCards";
import { patchAgent, roster } from "./roster";
import type { Doors } from "../doors";
import { inputOf } from "../machine/machineKit";
import { json } from "../../transport";

// The CI board over the fixture's runs, with rerun, dispatch, cancel and failure tracking acting on them, and
// Fix-with-agent opening a conversation on the failure. Main is failing, with its fix agents, only in the whole recording,
// the one roster that carries them.
const options = () => ({ mainFailing: demoMode.id === `full`, green: demoQuiet() });

const RERUN_PUSH_MS = 45_000;
// What a real Fix press waits on before any agent exists: the failed run's job list and each failed job's whole log, read
// from the forge (about 1 s and 2 s on GitHub for a 4 MB log), so the board's card standing in for it is seen as it is.
const FIX_READS_LOGS_MS = 3_000;

const startRun = (repo: string, runId: number, start: typeof rerunCi) => {
    if (start(repo, runId, Date.now()) === undefined) {
        refuse(`No run ${runId} on ${repo}.`, 404);
    }
    pushRuntime(`ci`);
    // The run ends on its own; the push is the webhook's delivery saying so.
    setTimeout(() => pushRuntime(`ci`), RERUN_PUSH_MS);
    return { ok: true as const };
};

export const ciDoors = {
    runs: () => ciRunsResponse(Date.now(), options()),
    jobs: ({ repo, runId }) => ({ jobs: ciJobs(repo, runId, Date.now(), demoQuiet()) }),
    rerun: ({ repo, runId }) => startRun(repo, runId, rerunCi),
    dispatch: ({ repo, runId }) => startRun(repo, runId, dispatchCi),
    cancel: ({ repo, runId }) => {
        if (!cancelCi(repo, runId, Date.now())) {
            refuse(`No run ${runId} on ${repo}.`, 404);
        }
        pushRuntime(`ci`);
        return { ok: true as const };
    },
} satisfies Doors<`ci`>;

const forget = (target: CiForgetParam) => {
    forgetCi(target);
    pushRuntime(`ci`);
    return { ok: true as const };
};

// One attempt per run: a second press continues the conversation already holding the failure.
const fix = async ({ repo, runId, mode }: CiFixParam) => {
    await new Promise((resolve) => setTimeout(resolve, FIX_READS_LOGS_MS));
    const run = ciRunsResponse(Date.now(), options()).runs.find((candidate) => candidate.repo === repo && candidate.runId === runId) ?? refuse(`No run ${runId} on ${repo}.`, 404);
    const conversationId = `ci-fix-${repo}-${runId}`;
    const now = Date.now();
    if (roster.agents.some((agent) => agent.id === conversationId) && mode !== `start-over`) {
        patchAgent(conversationId, { status: `running`, updatedAt: now });
        return { conversationId };
    }
    const failed = run.failedJobs?.join(`, `) ?? `the failed job`;
    putCard(workCard({ id: conversationId, title: ciFixTitle(run), now, startIn: repo, todo: `Reproduce ${failed} from its log` }));
    return { conversationId };
};

const PIPELINES = `/x/intentic.pipelines`;

export const pipelinesBackend = {
    [`GET ${PIPELINES}/runs`]: () => json(ciDoors.runs()),
    [`POST ${PIPELINES}/jobs`]: async ({ request }: RawContext) => json(ciDoors.jobs(await inputOf(CiRunParamSchema, request))),
    [`POST ${PIPELINES}/forget`]: async ({ request }: RawContext) => json(forget(await inputOf(CiForgetParamSchema, request))),
    [`POST ${PIPELINES}/fix`]: async ({ request }: RawContext) => json(await fix(await inputOf(CiFixParamSchema, request))),
};
