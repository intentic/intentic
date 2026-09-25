import { WORKSPACE_ROOT } from "@intentic/constants";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import type { ConversationActors } from "../agents/actor/conversation-actors.js";
import { parkedCards } from "../agents/actor/parked-cards.js";
import { createDomainEvents } from "../seams/domain-events.js";
import { memoryFleet } from "../testing.js";
import type { MemoryReading } from "@intentic/constants/memory-room";
import { budgetOn, ROOMY_READING } from "../agent/run/turn/turn-plan.testing.js";

// The daemon as a child spawn sees it (agent/subagents/children.ts): the settings it budgets by, the transcript a child
// turn appends to, the fleet it may be placed onto, and the actors its records, cards and runs are held by. Anything
// else names itself if a spawn reaches for it; the turn body is the suite's, bound with drivenBy (testing.ts).

// The fleet a spawn can be placed onto; empty by default, so a spawn places nothing and runs here.
export interface FakeRunner {
    readonly id: string;
    readonly online: boolean;
    readonly cpus?: number;
    readonly inFlight?: number;
}

// `conversations` are the actors the spawn's records, cards and runs are held by; a fresh fleet's unless the suite reads
// them itself. `memory` is the box a child waits on for room, roomy unless the suite makes it short; read afresh on every
// look, so a suite frees memory by changing what it returns.
export const spawnServices = (
    over: Partial<SandboxSettings> = {},
    fleet: readonly FakeRunner[] = [],
    conversations: ConversationActors = memoryFleet().conversations,
    memory: () => MemoryReading = () => ROOMY_READING,
): Services =>
    unstubbed<Services>("services", {
        resources: budgetOn(memory, { waitDeadlineMs: 10_000 }),
        // No conversation here was placed on a runner before, so a follow-up runs where a first turn would.
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => ({ ...SandboxSettingsSchema.parse({}), ...over }),
        }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { append: async () => {} }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: WORKSPACE_ROOT }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {} }),
        config: unstubbed<Services["config"]>("config", {
            // Only the fields the scheduler's parity read touches; the rest throw by name instead of being invented.
            sandbox: unstubbed<Services["config"]["sandbox"]>("config.sandbox", {
                image: "ghcr.io/intentic/sandbox:2",
                channel: "stable",
                environmentHash: "",
            }),
        }),
        runners: unstubbed<Services["runners"]>("runners", { list: async () => fleet.map((runner) => ({ id: runner.id, card: runner.id })) }),
        runnerHub: unstubbed<Services["runnerHub"]>("runnerHub", {
            state: (id: string) => {
                const found = fleet.find((runner) => runner.id === id);
                return found === undefined || !found.online
                    ? { online: false }
                    : {
                          online: true,
                          // No definitionToml: a hand-started runner never declares one, which placement tests don't
                          // care about.
                          announced: { version: "0.0.0", image: "ghcr.io/intentic/sandbox:2", channel: "stable" },
                          facts: { cpus: found.cpus ?? 8, memoryMb: 32_768, freeDiskMb: 100_000, load: 0.1 },
                      };
            },
        }),
        // Real actors, but for how many turns each runner has in flight, which the fleet above says.
        conversations: {
            ...conversations,
            inFlightByRunner: () =>
                new Map(fleet.flatMap((runner) => (runner.inFlight === undefined ? [] : [[runner.id, runner.inFlight] as const]))),
        },
        cards: parkedCards(conversations),
        // Heard by nobody: what reacts to a child's settled run is composition's to subscribe.
        events: createDomainEvents(() => {}),
    });
