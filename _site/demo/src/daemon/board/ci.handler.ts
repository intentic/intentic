import { refuse } from "@intentic/contract-serve";
import { cancelCi, ciJobs, ciRunsResponse, rerunCi } from "../../fixture/ci";
import { demoMode, demoQuiet } from "../../mode";
import { pushRuntime } from "../runtimePush";
import { putCard, workCard } from "./workCards";
import { patchAgent, roster } from "./roster";
import type { Doors } from "../doors";

// The CI board over the fixture's runs, with rerun and cancel acting on them (fixture/ci.ts plays a rerun's graph) and
// Fix-with-agent opening a conversation on the failure. Main is failing, with its fix agents, only in the whole recording,
// the one roster that carries them.
const options = () => ({ mainFailing: demoMode.id === `full`, green: demoQuiet() });

const RERUN_PUSH_MS = 45_000;

export const ciDoors = {
    runs: () => ciRunsResponse(Date.now(), options()),
    jobs: ({ repo, runId }) => ({ jobs: ciJobs(repo, runId, Date.now(), demoQuiet()) }),
    rerun: ({ repo, runId }) => {
        if (rerunCi(repo, runId, Date.now()) === undefined) {
            refuse(`No run ${runId} on ${repo}.`, 404);
        }
        pushRuntime(`ci`);
        // The run ends on its own; the push is the webhook's delivery saying so.
        setTimeout(() => pushRuntime(`ci`), RERUN_PUSH_MS);
        return { ok: true as const };
    },
    cancel: ({ repo, runId }) => {
        if (!cancelCi(repo, runId, Date.now())) {
            refuse(`No run ${runId} on ${repo}.`, 404);
        }
        pushRuntime(`ci`);
        return { ok: true as const };
    },
    // One attempt per run: a second press continues the conversation already holding the failure.
    fix: ({ repo, runId, mode }) => {
        const run = ciRunsResponse(Date.now(), options()).runs.find((candidate) => candidate.repo === repo && candidate.runId === runId) ?? refuse(`No run ${runId} on ${repo}.`, 404);
        const conversationId = `ci-fix-${repo}-${runId}`;
        const now = Date.now();
        if (roster.agents.some((agent) => agent.id === conversationId) && mode !== `start-over`) {
            patchAgent(conversationId, { status: `running`, updatedAt: now });
            return { conversationId };
        }
        const failed = run.failedJobs?.join(`, `) ?? `the failed job`;
        putCard(workCard({ id: conversationId, title: `Fix the failing pipeline on ${run.branch}`, now, startIn: repo, todo: `Reproduce ${failed} from its log` }));
        return { conversationId };
    },
} satisfies Doors<`ci`>;
