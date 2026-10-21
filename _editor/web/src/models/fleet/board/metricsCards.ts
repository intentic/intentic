import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { computed, type ComputedRef } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import type { FleetLane } from "../../agent-status/agentStatus-lanes";
import { type CardMetrics, cardUsages, runCardKey, showLiveMetrics } from "../../sandbox/liveMetrics";
import { useAgents } from "../useAgents";
import type { FleetAgent } from "../useAgents-fleet";
import { insideRun, runIdsInLedger } from "../useWorkflowRuns";
import { cardKey, foldChildren } from "./childFold";

// Which card on the board each conversation is drawn under, for the geek metrics to fold its processes into
// (liveMetrics.cardUsages). The board's own rules, read off this sandbox's whole fleet: a run's step rides its run's
// card for as long as the run is in the ledger (useWorkflowRuns.insideRun), and every other conversation rides the
// card its family is drawn under (childFold.foldChildren: spawned children, their children, fresh sessions on a card's
// work), unless it stands as a card of its own, which keeps its own figures. Not the board's scope (project, owner,
// other boxes): the metrics are this sandbox's, and a family is one family whichever of it a filter shows.

export const metricsCardOf = (lanes: Readonly<Record<FleetLane, readonly FleetAgent[]>>, runs: readonly WorkflowRun[]): ((id: string) => string) => {
    const ledger = runIdsInLedger(runs);
    const steps = new Map<string, string>();
    for (const run of runs) {
        for (const step of run.steps) {
            steps.set(step.conversationId, runCardKey(run.runId));
        }
    }
    const outside = (agent: FleetAgent): boolean => {
        if (agent.workflow !== undefined && insideRun(agent, ledger)) {
            steps.set(agent.id, runCardKey(agent.workflow.runId));
            return false;
        }
        return true;
    };
    const { hosts } = foldChildren({
        attention: lanes.attention.filter(outside),
        active: lanes.active.filter(outside),
        finished: lanes.finished.filter(outside),
    });
    return (id) => steps.get(id) ?? hosts.get(cardKey({ id, sandboxId: undefined }))?.id ?? id;
};

// What a press on a run's row in the panel opens: a running step's chat, else its latest step's.
const opensOf = (run: WorkflowRun): string | undefined => (run.steps.find((step) => step.state === `running`) ?? run.steps.at(-1))?.conversationId;

export const cardMetricsOf = (
    reading: SandboxMetrics,
    lanes: Readonly<Record<FleetLane, readonly FleetAgent[]>>,
    runs: readonly WorkflowRun[],
): CardMetrics => ({
    usage: cardUsages(reading.sessions, metricsCardOf(lanes, runs)),
    runs: new Map(runs.map((run) => [runCardKey(run.runId), { title: run.workflow.name, opens: opensOf(run) }])),
});

// Called once per window beside useLiveMetrics, by the desktop shell. The ledger is read only while the metrics are on.
export function useCardMetrics(metrics: ComputedRef<SandboxMetrics | undefined>): ComputedRef<CardMetrics | undefined> {
    const { lanes } = useAgents();
    const { query } = useSandboxQuery({ ...rpcQuery(`workflows.runs`), enabled: showLiveMetrics });
    return computed(() => {
        const reading = metrics.value;
        return reading === undefined ? undefined : cardMetricsOf(reading, lanes.value, query.data.value?.runs ?? []);
    });
}
