import type { LandResult } from "@intentic/sandbox-contract/schemas/agents";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { pino } from "pino";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { isolatedAgent } from "../registry/agents-store.testing.js";
import { memoryFleet } from "../registry/agents-registry.testing.js";
import { joined, NO_QUEUE, type TurnQueue } from "../actor/conversation-queue.js";
import { type ConversationState, idleConversation } from "../actor/conversation-state.js";
import type { IsolatedAgent, PersistedAgent } from "../registry/agents-store.js";
import type { LandStanding } from "./standing.js";
import { landHeldForWake, type WakeHeldLandDeps } from "./wake-held-land.js";
import { noteLandHeldForWake, takeLandHeldForWake } from "./wake-held.js";

// Pins the land a turn's close skipped for a wake, run once that wake goes away without firing: only for a conversation
// at rest that waits on nothing else, whose last turn ended clean and whose work is held on its branch, and only as the
// rules and the turn's own answer to landing would have had it at the close.

interface Held {
    readonly entry?: PersistedAgent;
    readonly standing?: LandStanding;
    readonly state?: ConversationState;
    readonly queue?: TurnQueue;
}

const ID = "c1";
const finished = isolatedAgent([{ repo: "root", base: "b0" }], { id: ID });

// One fleet's holdings, which hold what each close kept; every other reading is the case's own.
const fleet = memoryFleet().conversations;

const deps = (held: Held = {}): WakeHeldLandDeps => {
    const entry = held.entry ?? finished;
    return unstubbed<WakeHeldLandDeps>("services", {
        logger: pino({ level: "silent" }),
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id: string) => (id === entry.id ? entry : undefined),
            standingOf: () => held.standing ?? "ready",
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", {
            state: () => held.state ?? idleConversation(),
            queued: () => held.queue ?? NO_QUEUE,
            holdings: fleet.holdings,
        }),
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { worktreeDir: () => "/nowhere" }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
    });
};

// The land a press would run, recorded rather than run.
const landing = () => {
    const landed: string[] = [];
    const land = async (_services: unknown, entry: IsolatedAgent): Promise<LandResult> => {
        landed.push(entry.id);
        return { landed: true, changed: true };
    };
    return { land, landed };
};

const watching: ConversationState = { ...idleConversation(), watches: [{ id: "w1", note: "CI", intervalSeconds: 60, deadlineAt: 1 }] };
const running: ConversationState = { ...idleConversation(), phase: { kind: "running", startedAt: 1, parked: [], stopping: undefined } };

afterEach(() => {
    takeLandHeldForWake(fleet, ID);
});

describe("the land a wake held", () => {
    it("runs once the wake is gone, for a conversation at rest whose clean turn left its work on its branch", async () => {
        noteLandHeldForWake(fleet, ID, { autoLand: true });
        const { land, landed } = landing();
        await landHeldForWake(deps(), ID, land);
        expect(landed).toEqual([ID]);
        // Once: a second disarm has nothing left to land.
        await landHeldForWake(deps(), ID, land);
        expect(landed).toEqual([ID]);
    });

    it("waits, keeping it, while another wake or a turn is still to come: that turn's own close decides", async () => {
        noteLandHeldForWake(fleet, ID, { autoLand: true });
        const { land, landed } = landing();
        await landHeldForWake(deps({ state: watching }), ID, land);
        await landHeldForWake(deps({ state: running }), ID, land);
        expect(landed).toEqual([]);
        await landHeldForWake(deps(), ID, land);
        expect(landed).toEqual([ID]);
    });

    it("lands nothing for a conversation whose close held nothing", async () => {
        const { land, landed } = landing();
        await landHeldForWake(deps(), ID, land);
        expect(landed).toEqual([]);
    });

    it("lands nothing, and forgets it, where the turn asked not to land by itself", async () => {
        noteLandHeldForWake(fleet, ID, { autoLand: false });
        const { land, landed } = landing();
        await landHeldForWake(deps(), ID, land);
        expect(landed).toEqual([]);
        expect(takeLandHeldForWake(fleet, ID)).toBeUndefined();
    });

    it.each([
        ["its last turn was stopped", { entry: isolatedAgent([{ repo: "root", base: "b0" }], { id: ID, ending: { kind: "stopped" } }) }],
        ["a person's message waits for the next turn", { queue: joined(NO_QUEUE, { id: "m1", voice: "person", queuedAt: 1, turn: { conversationId: ID, prompt: "next" } }) }],
        ["the work is no longer held on its branch", { standing: "landed" as const }],
        ["the land already met a conflict", { standing: "conflict" as const }],
    ])("lands nothing, and forgets it, when %s", async (_case, held: Held) => {
        noteLandHeldForWake(fleet, ID, { autoLand: true });
        const { land, landed } = landing();
        await landHeldForWake(deps(held), ID, land);
        expect(landed).toEqual([]);
        expect(takeLandHeldForWake(fleet, ID)).toBeUndefined();
    });

    it("never throws for a land that broke: the disarm that asked must not fail on it", async () => {
        noteLandHeldForWake(fleet, ID, { autoLand: true });
        const broken = async (): Promise<LandResult> => {
            throw new Error("index.lock");
        };
        await expect(landHeldForWake(deps(), ID, broken)).resolves.toBeUndefined();
    });
});
