import "@intentic/testing/dom";
import type { SandboxMetrics } from "@intentic/sandbox-contract/schemas/metrics";
import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import { runCardKey } from "../../sandbox/liveMetrics";
import { type FleetAgent, laneGroups } from "../useAgents-fleet";
import { cardMetricsOf, metricsCardOf } from "./metricsCards";

// Pins that the geek metrics fold each conversation into the card the board draws it under: a spawned child and its
// own child into their parent's card, a run's steps into the run's, and a child standing as a card of its own (owing a
// land) keeps its own figures, since only what stands alone on the board is counted alone.

const MIB = 2 ** 20;

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `running`,
    startedAt: 1_000,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const child = (id: string, parent: string, over: Partial<FleetAgent> = {}): FleetAgent => card(id, { startedBy: `agent:${parent}`, ...over });
const step = (id: string, runId: string): FleetAgent => card(id, { workflow: { runId, name: `Review`, step: `first`, index: 0, total: 1 } });
const run = (runId: string, conversations: readonly string[]): WorkflowRun => ({
    runId,
    workflow: { id: `wf`, name: `Nightly review`, steps: [], maxParallel: 1 },
    repos: [],
    state: `running`,
    startedAt: 1,
    resumed: 0,
    steps: conversations.map((conversationId, at) => ({ stepId: `s${at}`, conversationId, state: at === 0 ? `done` : `running`, iterations: 0 })),
});

const reading = (sessions: SandboxMetrics[`sessions`]): SandboxMetrics => ({
    at: 1,
    sandbox: { cores: 4, memoryBytes: 1, memoryLimitBytes: 16 * 1024 * MIB, loadAverage: [0, 0, 0], processes: 3 },
    daemon: { rssBytes: 1, heapUsedBytes: 1 },
    sessions,
    roles: {},
});

describe(`which card a conversation's processes count on`, () => {
    it(`counts a spawned child and its own child on the card they ride under`, () => {
        const cardOf = metricsCardOf(laneGroups([card(`p`), child(`c`, `p`), child(`g`, `c`), card(`other`)]), []);
        expect([`p`, `c`, `g`, `other`].map(cardOf)).toEqual([`p`, `p`, `p`, `other`]);
    });

    it(`keeps a child that stands as a card of its own on its own card, and one the fleet does not know on itself`, () => {
        const cardOf = metricsCardOf(laneGroups([card(`p`), child(`ready`, `p`, { status: `ready` })]), []);
        expect([cardOf(`ready`), cardOf(`gone`)]).toEqual([`ready`, `gone`]);
    });

    it(`counts a run's steps on the run's card, whether or not the fleet holds them`, () => {
        const cardOf = metricsCardOf(laneGroups([step(`s1`, `r1`), card(`p`)]), [run(`r1`, [`s1`, `s2`])]);
        expect([cardOf(`s1`), cardOf(`s2`), cardOf(`p`)]).toEqual([runCardKey(`r1`), runCardKey(`r1`), `p`]);
    });
});

describe(`a card's usage`, () => {
    it(`sums its family's memory, CPU and processes, and says what the grouped sessions hold`, () => {
        const { usage, runs } = cardMetricsOf(
            reading({
                p: { processes: 2, rssBytes: 300 * MIB, cpuPercent: 1.2 },
                c: { processes: 5, rssBytes: 900 * MIB, cpuPercent: 80 },
                g: { processes: 1, rssBytes: 100 * MIB },
                s2: { processes: 3, rssBytes: 200 * MIB, cpuPercent: 10 },
            }),
            laneGroups([card(`p`), child(`c`, `p`), child(`g`, `c`)]),
            [run(`r1`, [`s1`, `s2`])],
        );
        expect(usage.get(`p`)).toEqual({ rssBytes: 1300 * MIB, cpuPercent: 81.2, processes: 8, grouped: 2, groupedRssBytes: 1000 * MIB });
        expect(usage.get(runCardKey(`r1`))).toEqual({ rssBytes: 200 * MIB, cpuPercent: 10, processes: 3, grouped: 1, groupedRssBytes: 200 * MIB });
        expect([...usage.keys()].toSorted()).toEqual([`p`, runCardKey(`r1`)]);
        // A press on the run's row opens its running step.
        expect(runs.get(runCardKey(`r1`))).toEqual({ title: `Nightly review`, opens: `s2` });
    });

    it(`has no CPU figure while none of the family has one yet`, () => {
        const { usage } = cardMetricsOf(reading({ c: { processes: 1, rssBytes: MIB } }), laneGroups([card(`p`), child(`c`, `p`)]), []);
        expect(usage.get(`p`)?.cpuPercent).toBeUndefined();
    });
});
