import { waitFor } from "@intentic/testing/bun";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { liveRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { beginTurn } from "../../../conversations/actor/conversation-actors.testing.js";
import type { Fleet } from "../../../conversations/registry/agents-registry.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { spawnServices } from "../../../harness/spawn-services.testing.js";
import { deliverWake } from "../../../seams/wake-delivery.js";
import type { TurnStarter } from "../../../seams/turn-starter.js";
import { drivenBy } from "../../../seams/turn-starter.testing.js";
import { conversationIdentity, mainTreePlacement, placedTurn } from "../../run/placement/turn-placement.js";
import { CHILDREN } from "../child-records.js";
import { CANCEL_NOTES, NOTHING_TO_CANCEL } from "../child-words.js";
import { type ChildParent, resetChildrenForTest, sendToChild, spawnChild } from "../children.js";
import { cancelChild, descendsFrom } from "../family/child-cancel.js";
import { HALTED_WORDS, haltOf } from "../../../conversations/actor/conversation-halt.js";
import { resetSubagents } from "../subagents.js";

// 2026-11-24, shinobi-society: an orchestrator told to stop all its subagents cancelled the six it had spawned, was refused
// "No such child" for the five those six had spawned (the board drew all eleven under its card), woke the six again to
// cancel their own, and four of the five came back by themselves. A cancel now reaches everything below the conversation
// it names, from any conversation above it, and what it stops stays stopped until somebody writes to it.

const parent: ChildParent = { conversationId: "conv-orchestrator", cwd: WORKSPACE_ROOT };

// A child whose task says "hold" works until its turn is stopped; any other ends at once.
async function* runtime(prompt: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    yield { kind: "delta", text: "On it." };
    if (prompt.includes("hold") && !signal.aborted) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    }
    yield { kind: "done" };
}

// The daemon's own turn body over a real fleet: a child's conversation opens on the registry, folds its frames, and
// registers its turn as stream-agent.ts does, so a stop reaches the runtime.
const fleetBody =
    (fleet: Fleet): TurnStarter["stream"] =>
    async function* opened(input) {
        const conversationId = input.conversationId ?? "";
        await beginTurn(fleet.conversations, conversationIdentity(input, conversationId, { isolated: true, runner: undefined }), Date.now());
        const controller = new AbortController();
        const unregister = fleet.conversations.registerTurn(conversationId, { abort: () => controller.abort() });
        try {
            yield* placedTurn(
                fleet.conversations,
                conversationId,
                mainTreePlacement(() => runtime(input.prompt, controller.signal)),
            );
        } finally {
            unregister();
        }
    };

const setUp = async (): Promise<{ readonly fleet: Fleet; readonly services: Services }> => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    resetSubagents(fleet.conversations);
    resetChildrenForTest(fleet.conversations);
    const base = spawnServices({ subagentDepth: 3 }, [], fleet.conversations);
    // Not a runner: a wake goes through this sandbox's own admission.
    const services = drivenBy(unstubbed<Services>("services", { ...base, agents: fleet.agents, runnerParent: {} }), fleetBody(fleet));
    return { fleet, services };
};

const spawned = async (services: Services, by: ChildParent, prompt: string): Promise<string> => {
    const result = await spawnChild(services, by, { prompt, provider: "claude", model: "claude-opus-5-5" });
    if (!result.ok) {
        throw new Error(result.message);
    }
    return result.id;
};

// Waits until the condition holds (waitFor returns on the first call that does not throw).
const until = (what: string, holds: () => boolean): Promise<void> =>
    waitFor(
        () => {
            if (!holds()) {
                throw new Error(`still waiting: ${what}`);
            }
        },
        { timeout: 5_000 },
    );

// Its turn has begun: a live run on its conversation.
const working = (services: Services, id: string): Promise<void> => until(`${id} working`, () => liveRunOf(services.conversations, id) !== undefined);

// Its turn has stopped and its record says so.
const stopped = (services: Services, id: string): Promise<void> =>
    until(`${id} stopped`, () => liveRunOf(services.conversations, id) === undefined && services.conversations.holdings(CHILDREN).get(id)?.running === false);

describe("a cancel from above", () => {
    it("reaches a subagent a child spawned, which the board draws under the same card", async () => {
        const { services } = await setUp();
        const slice = await spawned(services, parent, "Slice: hold the quaternion benches");
        await working(services, slice);
        const grandchild = await spawned(services, { conversationId: slice, cwd: WORKSPACE_ROOT }, "Sub-slice: hold the Quat::mul arena");
        await working(services, grandchild);

        expect(descendsFrom(services, grandchild, parent.conversationId)).toBe(true);
        expect(await cancelChild(services, parent, grandchild)).toEqual({ ok: true, note: CANCEL_NOTES.running });
        await stopped(services, grandchild);
        // The slice works on: only what was named, and what is below it, stops.
        expect([liveRunOf(services.conversations, slice) === undefined, haltOf(services.conversations, slice)]).toEqual([false, undefined]);
        expect(haltOf(services.conversations, grandchild)).toMatchObject({ by: "agent" });
        expect(await cancelChild(services, parent, slice)).toMatchObject({ ok: true });
        await stopped(services, slice);
    });

    it("stops a child and every subagent below it, each staying stopped until a message reaches it", async () => {
        const { services } = await setUp();
        const slice = await spawned(services, parent, "Slice: hold the vectors benches");
        await working(services, slice);
        const grandchild = await spawned(services, { conversationId: slice, cwd: WORKSPACE_ROOT }, "Sub-slice: hold the colour arena");
        await working(services, grandchild);

        expect(await cancelChild(services, parent, slice)).toEqual({
            ok: true,
            note: `${CANCEL_NOTES.running} 1 subagent below it (ones it started, and theirs) was cancelled with it, and stay stopped until a message reaches them.`,
        });
        await stopped(services, slice);
        await stopped(services, grandchild);
        expect([haltOf(services.conversations, slice)?.by, haltOf(services.conversations, grandchild)?.by]).toEqual(["agent", "agent"]);

        // What would have woken it by itself (a watch's report, a finished job) goes nowhere.
        const wake = { voice: "sandbox" as const, prompt: "Watch fired: the bench run ended.", profile: {} };
        expect(await deliverWake({ turns: services.turns }, { ...wake, conversationId: grandchild })).toEqual({ why: HALTED_WORDS });
        expect(liveRunOf(services.conversations, grandchild)).toBeUndefined();

        // Its parent's words carry it on.
        expect(await sendToChild(services, { conversationId: slice, cwd: WORKSPACE_ROOT }, grandchild, "Carry on with the colour arena.")).toMatchObject({ ok: true });
        expect(haltOf(services.conversations, grandchild)).toBeUndefined();
    });

    it("leaves a conversation outside the caller's subtree out of its reach", async () => {
        const { services } = await setUp();
        const theirs = await spawned(services, { conversationId: "conv-someone-else", cwd: WORKSPACE_ROOT }, "Audit the trades");
        expect(descendsFrom(services, theirs, parent.conversationId)).toBe(false);
        expect(await cancelChild(services, parent, theirs)).toEqual({ ok: false, message: "No such child of this conversation. `list` shows yours." });
        expect(haltOf(services.conversations, theirs)).toBeUndefined();
    });

    it("stops every child of the caller's at once with `all`", async () => {
        const { services } = await setUp();
        const first = await spawned(services, parent, "Slice: hold the rays");
        const second = await spawned(services, parent, "Slice: hold the sorting");
        await working(services, first);
        await working(services, second);
        expect(await cancelChild(services, parent, "all")).toEqual({
            ok: true,
            note: "Cancelled 2 of your 2 subagents, with everything below them. Each stays stopped until you or a person send it a message; what each wrote stays on its own branch (merge brings one into your checkout).",
        });
        await stopped(services, first);
        await stopped(services, second);
    });

    it("leaves a finished child with nothing to wake it as it was, and says there was nothing to cancel", async () => {
        const { services } = await setUp();
        const done = await spawned(services, parent, "Count the benches");
        await stopped(services, done);
        expect(await cancelChild(services, parent, done)).toEqual({ ok: false, message: NOTHING_TO_CANCEL });
        expect(haltOf(services.conversations, done)).toBeUndefined();
    });
});
