import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { createAdmission } from "../../agent/run/turn/turn-admission.js";
import { createDomainEvents } from "../../seams/domain-events.js";
import type { TurnInput, TurnStarter } from "../../seams/turn-starter.js";
import type { Fleet } from "../registry/agents-registry.js";

/**
 * The daemon a peer's message reaches in a suite: the fleet's registry and actors, nothing live to steer into, and the
 * real door every message nobody typed takes (turn-admission.ts `say`) over a start that records each turn it is asked
 * for and answers it with a run of its own, `run-1`, `run-2`, … What the door hands the start is what a turn would run.
 */
export const messageDaemon = (fleet: Fleet, overrides: Partial<Services> = {}) => {
    const started: TurnInput[] = [];
    const start: TurnStarter["start"] = async (turn) => {
        started.push(turn);
        return { id: `run-${started.length}`, async *frames() {} };
    };
    const services: Services = unstubbed<Services>("services", {
        agents: fleet.agents,
        conversations: fleet.conversations,
        events: createDomainEvents(() => {}),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { page: async () => ({ rows: [], from: 0, more: false }) }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {} }),
        turns: unstubbed<Services["turns"]>("turns", { steer: async () => false, ...createAdmission(() => services, start) }),
        ...overrides,
    });
    return { services, started };
};
