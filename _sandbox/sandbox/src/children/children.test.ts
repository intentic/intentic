import { type AgentEvent, type AgentTurn, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { listSubagentSessions, resetSubagents, waitForSubagent } from "../agent/subagents.js";
import type { Services } from "../composition.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { resetChildrenForTest, spawnChild } from "./children.js";

/* The spawn engine, driven through its real entry point with a fake turn generator, the loop pump's own test
 * shape. What the suite defends is the seam's PROMISES rather than its plumbing: a child is an ordinary
 * isolated unattended conversation on the provider the spec names; the budgets are enforced in the daemon;
 * and the roster record a parent's `wait` parks on moves with the child's own frames. */

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({ ...SandboxSettingsSchema.parse({}), ...over });

const fakeServices = (over: Partial<SandboxSettings> = {}): Services =>
    unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings(over) }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { open: async () => {}, append: async () => {} }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: "/work" }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {}, error: () => {} }),
    });

// A child's whole turn, recorded and scripted: `turns` collects what the pump was asked to run, `events` is
// what the child says back. The generator ends the turn, which is what settles the record.
const fakeTurn = (turns: AgentTurn[], events: AgentEvent[] = [{ kind: "done" }]): TurnFn =>
    // eslint-disable-next-line require-yield
    async function* fake(_services, input: AgentTurn) {
        turns.push(input);
        yield* events;
    };

const parent = { conversationId: "conv-parent", cwd: "/work" };

// The child settles on its own detached pump; the parent's own wait primitive is how a test (like a parent)
// finds out, which keeps the suite honest about the only observation surface a real parent has.
const settled = (id: string): Promise<unknown> => waitForSubagent(parent.conversationId, { target: id, until: ["finished"], timeoutMs: 5_000 });

beforeEach(() => {
    resetSubagents();
    resetChildrenForTest();
});

describe("what a child is", () => {
    it("runs as an isolated, unattended conversation on the provider the spec names", async () => {
        const turns: AgentTurn[] = [];
        const result = await spawnChild(fakeServices(), parent, { prompt: "Port the parser to zig", provider: "cursor", model: "composer-2.5" }, fakeTurn(turns));
        if (!result.ok) {
            throw new Error(result.message);
        }
        expect(result.id.startsWith("sub-")).toBe(true);
        await settled(result.id);
        expect(turns[0]).toMatchObject({
            conversationId: result.id,
            prompt: "Port the parser to zig",
            isolated: true,
            unattended: true,
            agent: "cursor",
            harness: "native",
            model: "composer-2.5",
        });
    });

    it("files the record under the parent, wearing the provider's label and the model", async () => {
        const result = await spawnChild(
            fakeServices(),
            parent,
            { prompt: "Port the parser", description: "Port the parser", provider: "cursor", model: "composer-2.5" },
            fakeTurn([], []),
        );
        if (!result.ok) {
            throw new Error(result.message);
        }
        expect(listSubagentSessions()[0]).toMatchObject({
            id: result.id,
            kind: "spawned",
            conversationId: "conv-parent",
            agentType: "Cursor",
            provider: "cursor",
            model: "composer-2.5",
            description: "Port the parser",
            spawnDepth: 1,
            background: true,
        });
    });
});

describe("the child's life on the roster", () => {
    it("takes the LAST closed bubble as the report: a turn's closing text is its answer", async () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "Let me look around first." },
            { kind: "text_end" },
            { kind: "delta", text: "Done: the parser now " },
            { kind: "delta", text: "handles nested arrays." },
            { kind: "text_end" },
            { kind: "done" },
        ];
        const result = await spawnChild(fakeServices(), parent, { prompt: "go" }, fakeTurn([], events));
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(listSubagentSessions()[0]).toMatchObject({ status: "completed", summary: "Done: the parser now handles nested arrays." });
    });

    it("parks as blocked with the question's own words, which is what the parent's wait returns", async () => {
        const gate = Promise.withResolvers<void>();
        const question: AgentEvent = {
            kind: "question",
            requestId: "q1",
            questions: [
                {
                    question: "Which port should the server bind?",
                    header: "Port",
                    multiSelect: false,
                    options: [
                        { label: "3000", description: "the dev default" },
                        { label: "8080", description: "the deploy default" },
                    ],
                },
            ],
        };
        const holdAt = async function* (services: Services, input: AgentTurn): AsyncGenerator<AgentEvent> {
            void services;
            void input;
            yield question;
            await gate.promise;
            yield { kind: "resolved", requestId: "q1" };
            yield { kind: "done" };
        };
        const result = await spawnChild(fakeServices(), parent, { prompt: "go" }, holdAt);
        if (!result.ok) {
            throw new Error(result.message);
        }
        const blocked = await waitForSubagent(parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        expect(blocked).toMatchObject({ outcome: "blocked", matched: { summary: "Which port should the server bind?" } });
        gate.resolve();
        await settled(result.id);
        expect(listSubagentSessions()[0]?.status).toBe("completed");
    });

    it("settles a turn that errored as failed, keeping the error", async () => {
        const events: AgentEvent[] = [{ kind: "error", message: "no Cursor subscription connected" }, { kind: "done" }];
        const result = await spawnChild(fakeServices(), parent, { prompt: "go" }, fakeTurn([], events));
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(listSubagentSessions()[0]).toMatchObject({ status: "failed", error: "no Cursor subscription connected" });
    });
});

describe("the budgets, enforced in the daemon", () => {
    it("refuses past the live ceiling, and frees the slot when a child settles", async () => {
        const gate = Promise.withResolvers<void>();
        const holdOpen = async function* (services: Services, input: AgentTurn): AsyncGenerator<AgentEvent> {
            void services;
            void input;
            await gate.promise;
            yield { kind: "done" };
        };
        const services = fakeServices({ subagentsAtOnce: 1 });
        const first = await spawnChild(services, parent, { prompt: "one" }, holdOpen);
        expect(first.ok).toBe(true);
        const second = await spawnChild(services, parent, { prompt: "two" }, holdOpen);
        expect(second).toMatchObject({ ok: false, message: expect.stringContaining("already running") });
        gate.resolve();
        if (first.ok) {
            await settled(first.id);
        }
        const third = await spawnChild(services, parent, { prompt: "three" }, holdOpen);
        expect(third.ok).toBe(true);
        gate.resolve();
    });

    it("refuses past the lifetime budget", async () => {
        const services = fakeServices({ subagentsPerTurn: 1 });
        const first = await spawnChild(services, parent, { prompt: "one" }, fakeTurn([]));
        expect(first.ok).toBe(true);
        if (first.ok) {
            await settled(first.id);
        }
        const second = await spawnChild(services, parent, { prompt: "two" }, fakeTurn([]));
        expect(second).toMatchObject({ ok: false, message: expect.stringContaining("lifetime budget") });
    });

    /* The runaway case the depth setting exists for: a child gets the spawn tool too, so the cap a chain
     * cannot read its way around has to live here, keyed by the CHILD's conversation id. */
    it("refuses a chain deeper than the owner's setting", async () => {
        const services = fakeServices({ subagentDepth: 1 });
        const first = await spawnChild(services, parent, { prompt: "one" }, fakeTurn([]));
        if (!first.ok) {
            throw new Error(first.message);
        }
        const fromChild = await spawnChild(services, { conversationId: first.id, cwd: "/work" }, { prompt: "two" }, fakeTurn([]));
        expect(fromChild).toMatchObject({ ok: false, message: expect.stringContaining("depth") });
        await settled(first.id);
    });
});
