import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { createDomainEvents } from "../../../../seams/domain-events.js";
import { SteeringQueue } from "../../../checkpoints/agent-steering.js";
import type { Steer } from "../../../../seams/turn-starter.js";
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

// 2026-11-23: words for a conversation placed on a runner went into the relay's own steering queue, which nothing drains,
// and were reported delivered. Every voice now goes through the runner's steer door, saying whose words they are.
describe("words steered into a turn running on a runner", () => {
    const onRunner = (applied: boolean) => {
        const sent: unknown[] = [];
        const services = {
            workspace: { root: "/nowhere" },
            logger: { warn: () => undefined },
            agents: { entry: () => ({ placement: { kind: "worktree", runner: "rog", repos: [] } }) },
            runnerHub: {
                client: () => ({
                    steer: async (input: unknown) => {
                        sent.push(input);
                        return { applied };
                    },
                }),
            },
        };
        return { services, sent };
    };
    // SAFETY: steerComposed reads only workspace, logger, agents, runnerHub and conversations, which each suite fakes.
    const steerOn = (services: object, ...rest: [string, Steer]) => steerComposed(services as Parameters<typeof steerComposed>[0], ...rest);

    test("reach the runner with their voice and errand, and leave their row here", async () => {
        const { conversations, run, release } = liveTurn("c-remote");
        const { services, sent } = onRunner(true);
        const steered = await steerOn({ ...services, conversations }, "c-remote", {
            text: "also the lexer",
            voice: "agent",
            errand: "land-fix-nudge",
        });
        expect(steered).toBe(true);
        expect(sent).toMatchObject([{ conversationId: "c-remote", text: "also the lexer", voice: "agent", errand: "land-fix-nudge" }]);
        expect(run.rows.at(-1)).toMatchObject({ role: "user", text: "also the lexer", errand: "land-fix-nudge" });
        release();
    });

    test("answer false, leaving no row, when the runner's turn takes no words", async () => {
        const { conversations, run, release } = liveTurn("c-remote-idle");
        const before = run.rows.length;
        const { services } = onRunner(false);
        expect(await steerOn({ ...services, conversations }, "c-remote-idle", { text: "hello", voice: "sandbox" })).toBe(false);
        expect(run.rows).toHaveLength(before);
        release();
    });

    test("answer false when the runner is offline", async () => {
        const { conversations, release } = liveTurn("c-remote-off");
        const { services } = onRunner(true);
        const offline = { ...services, runnerHub: { client: () => undefined } };
        expect(await steerOn({ ...offline, conversations }, "c-remote-off", { text: "hello", voice: "agent" })).toBe(false);
        release();
    });

    // Review, 2026-11-23: words for a runner skipped the composing that refuses an escaping attachment here, and their
    // files were read wherever the paths led. The same rule now holds before a byte is read.
    test("refuse an attachment escaping the workspace without reaching the runner", async () => {
        const { conversations, release } = liveTurn("c-remote-escape");
        const { services, sent } = onRunner(true);
        const steered = await steerOn({ ...services, conversations }, "c-remote-escape", { text: "see", voice: "person", attachments: ["../../history/secret"] });
        expect(steered).toEqual({ invalid: "invalid attachment path: ../../history/secret" });
        expect(sent).toEqual([]);
        release();
    });
});
