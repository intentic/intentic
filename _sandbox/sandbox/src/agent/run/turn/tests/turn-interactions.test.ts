import type { AgentEvent } from "@intentic/sandbox-contract";
import { memoryFleet } from "../../../../testing.js";
import { createDomainEvents } from "../../../../seams/domain-events.js";
import { SteeringQueue } from "../../../checkpoints/agent-steering.js";
import { steerComposed } from "../turn-interactions.js";
import { startTurnRun } from "../turn-runs.js";

// A live turn held open until released, with a steering queue registered so it takes words.
const liveTurn = (conversationId: string) => {
    const conversations = memoryFleet().conversations;
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const run = startTurnRun(
        { conversations, events: createDomainEvents(() => {}) },
        async function* (): AsyncGenerator<AgentEvent> {
            await held;
            yield { kind: "done" };
        },
        { prompt: "start", conversationId },
    );
    if (typeof run === "string") {
        throw new Error(`no run on ${conversationId}: ${run}`);
    }
    conversations.registerTurn(conversationId, { abort: () => {}, steering: new SteeringQueue() });
    return { conversations, run, release };
};

describe("words steered into a local turn", () => {
    // The port's door and admission's queue both steer through here; a field one dropped never reached the row.
    test("carry their errand onto the row they become", async () => {
        const { conversations, run, release } = liveTurn("c-errand");
        const steered = await steerComposed({ conversations, workspace: { root: "/nowhere" } as never }, "c-errand", {
            text: "keep going",
            voice: "sandbox",
            errand: "land-fix-nudge",
        });
        expect(steered).toBe(true);
        expect(run.rows.at(-1)).toMatchObject({ errand: "land-fix-nudge" });
        release();
    });

    test("are refused, and reach no turn, when a reference escapes the workspace", async () => {
        const { conversations, run, release } = liveTurn("c-escape");
        const before = run.rows.length;
        const steered = await steerComposed({ conversations, workspace: { root: "/nowhere" } as never }, "c-escape", {
            text: "look at this",
            voice: "sandbox",
            attachments: ["../outside"],
        });
        expect(steered).toStrictEqual({ invalid: "invalid attachment path: ../outside" });
        expect(run.rows).toHaveLength(before);
        release();
    });

    test("answer false when no turn takes them", async () => {
        const conversations = memoryFleet().conversations;
        expect(await steerComposed({ conversations, workspace: { root: "/nowhere" } as never }, "c-none", { text: "hello", voice: "sandbox" })).toBe(
            false,
        );
    });
});
