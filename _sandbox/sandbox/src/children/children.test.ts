import { type AgentEvent, type AgentTurn, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { listSubagentSessions, resetSubagents, waitForSubagent } from "../agent/subagents.js";
import type { Services } from "../composition.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { createRequest } from "../agent/agent-requests.js";
import { clearTurnTaint, conversationTaintSource, createTurnTaint, publishTurnTaint } from "../guard/turn-taint.js";
import { answerChild, armSupervisor, pendingQuestionOf, resetChildrenForTest, sendToChild, spawnChild, supervisorFor, type ChildSupervisor } from "./children.js";

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

/* THE OWNER'S RULE AND THE FLOORS (guard/actions.ts childSpawn), consulted on every supervisor mutation, so
 * the rulebook binds on every door at once. The taint floor composes BOTH ways: a parent that has taken in
 * outside content may not reach its children unless the owner explicitly allowed it, and a child on a runtime
 * beyond every gate (rulebook "none") marks the parent's own turn bit on its way out. */
describe("the spawn rulebook and the floors", () => {
    it("a deny rule refuses every door's spawn, a per-provider hold names the owner", async () => {
        const denied = await spawnChild(fakeServices({ actionRules: { "agents.spawn": "deny" } }), parent, { prompt: "go" }, fakeTurn([]));
        expect(denied).toMatchObject({ ok: false, message: expect.stringContaining("refused") });
        const held = await spawnChild(
            fakeServices({ actionRules: { "agents.spawn.cursor": "hold" } }),
            parent,
            { prompt: "go", provider: "cursor" },
            fakeTurn([]),
        );
        expect(held).toMatchObject({ ok: false, message: expect.stringContaining("owner") });
        // The blanket rule does not reach a provider the owner singled out as allowed.
        const other = await spawnChild(fakeServices({ actionRules: { "agents.spawn.cursor": "hold" } }), parent, { prompt: "go" }, fakeTurn([]));
        expect(other.ok).toBe(true);
        if (other.ok) {
            await settled(other.id);
        }
    });

    it("a tainted parent is held from every mutation, unless the owner explicitly allowed the surface", async () => {
        const taint = createTurnTaint();
        taint.mark("webchat");
        publishTurnTaint(parent.conversationId, taint);
        try {
            const held = await spawnChild(fakeServices(), parent, { prompt: "go" }, fakeTurn([]));
            expect(held).toMatchObject({ ok: false, message: expect.stringContaining("webchat") });
            const allowed = await spawnChild(fakeServices({ actionRules: { "agents.spawn": "allow" } }), parent, { prompt: "go" }, fakeTurn([]));
            expect(allowed.ok).toBe(true);
            if (allowed.ok) {
                await settled(allowed.id);
                const sent = await sendToChild(fakeServices(), parent, allowed.id, "more", fakeTurn([]));
                expect(sent).toMatchObject({ ok: false, message: expect.stringContaining("webchat") });
            }
        } finally {
            clearTurnTaint(parent.conversationId);
        }
    });

    it("a child on a runtime beyond every gate marks the parent's own turn bit", async () => {
        publishTurnTaint(parent.conversationId, createTurnTaint());
        try {
            expect(conversationTaintSource(parent.conversationId)).toBeUndefined();
            const result = await spawnChild(fakeServices(), parent, { prompt: "go", provider: "pi" }, fakeTurn([]));
            expect(result.ok).toBe(true);
            expect(conversationTaintSource(parent.conversationId)).toBe("agent:pi");
            if (result.ok) {
                await settled(result.id);
            }
        } finally {
            clearTurnTaint(parent.conversationId);
        }
    });
});

/* THE ESCALATION LADDER, and its one hard rule. A child's QUESTION is the parent's to answer — the parent
 * often holds the information — through the very request registry the child's ask parked on, so the picks
 * arrive exactly as an owner's would. A child's CONSENT cards (permission, plan) refuse BY KIND: a parent
 * that could approve its child's held commands would be a model approving its own dangerous actions through a
 * proxy. `send` steers a working child where its runtime takes mid-turn input, and runs a follow-up turn on a
 * settled one, continuing the session its last turn reported. */
describe("the escalation ladder", () => {
    const questionFrame = (requestId: string): AgentEvent => ({
        kind: "question",
        requestId,
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
    });

    it("answers a child's question through the real request registry, and the child carries on", async () => {
        // The child's ask, exactly as its runtime would raise it: a parked request whose id rides the frame.
        const { id: requestId, wait: parked } = createRequest("question", { kind: "question", requestId: "", cancelled: true });
        const asked = parked(new AbortController().signal);
        const gate = Promise.withResolvers<void>();
        const askThenFinish = async function* (services: Services, input: AgentTurn): AsyncGenerator<AgentEvent> {
            void services;
            void input;
            yield questionFrame(requestId);
            await gate.promise;
            yield { kind: "resolved", requestId };
            yield { kind: "delta", text: "Bound to 8080." };
            yield { kind: "text_end" };
            yield { kind: "done" };
        };
        const services = fakeServices();
        const result = await spawnChild(services, parent, { prompt: "go" }, askThenFinish);
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        // The wait surfaces hand the parent the WHOLE question, options included.
        expect(pendingQuestionOf(result.id)).toMatchObject({
            kind: "question",
            requestId,
            questions: [{ question: "Which port should the server bind?" }],
        });
        const answered = await answerChild(services, parent, result.id, { "Which port should the server bind?": ["8080"] });
        expect(answered.ok).toBe(true);
        // The child's parked ask settled with the parent's picks, as a real answer rather than the abort stand-in.
        await expect(asked).resolves.toMatchObject({ reply: { kind: "question", answers: { "Which port should the server bind?": ["8080"] } } });
        gate.resolve();
        await settled(result.id);
        expect(listSubagentSessions()[0]).toMatchObject({ status: "completed", summary: "Bound to 8080." });
    });

    it("refuses to answer a consent card, by kind, with the owner named", async () => {
        const gate = Promise.withResolvers<void>();
        const holdOnPermission = async function* (services: Services, input: AgentTurn): AsyncGenerator<AgentEvent> {
            void services;
            void input;
            yield { kind: "permission", requestId: "p1", toolName: "Bash", title: "Run rm -rf build" };
            await gate.promise;
            yield { kind: "done" };
        };
        const result = await spawnChild(fakeServices(), parent, { prompt: "go" }, holdOnPermission);
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        // The consent card is not a question: the wait surfaces hand the parent nothing to answer with…
        expect(pendingQuestionOf(result.id)).toBeUndefined();
        // …and a direct attempt refuses by kind, naming whose the card is.
        const refused = await answerChild(fakeServices(), parent, result.id, { anything: ["yes"] });
        expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("owner") });
        gate.resolve();
        await settled(result.id);
    });

    it("refuses a stranger's child and a child waiting on nothing", async () => {
        const result = await spawnChild(fakeServices(), parent, { prompt: "go" }, fakeTurn([]));
        if (!result.ok) {
            throw new Error(result.message);
        }
        await expect(answerChild(fakeServices(), { conversationId: "conv-other", cwd: "/work" }, result.id, {})).resolves.toMatchObject({ ok: false });
        await settled(result.id);
        await expect(answerChild(fakeServices(), parent, result.id, {})).resolves.toMatchObject({ ok: false, message: expect.stringContaining("not waiting") });
    });

    it("send to a settled child runs a follow-up turn on its own conversation, continuing its session", async () => {
        const turns: AgentTurn[] = [];
        const withSession = async function* (services: Services, input: AgentTurn): AsyncGenerator<AgentEvent> {
            void services;
            turns.push(input);
            yield { kind: "session", sessionId: "sess-child-1" };
            yield { kind: "delta", text: "first pass done" };
            yield { kind: "text_end" };
            yield { kind: "done" };
        };
        const services = fakeServices();
        const result = await spawnChild(services, parent, { prompt: "port it", provider: "cursor", model: "composer-2.5" }, withSession);
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        const sent = await sendToChild(services, parent, result.id, "also handle nested arrays", withSession);
        expect(sent.ok).toBe(true);
        await settled(result.id);
        expect(turns[1]).toMatchObject({
            conversationId: result.id,
            prompt: "also handle nested arrays",
            sessionId: "sess-child-1",
            agent: "cursor",
            model: "composer-2.5",
            isolated: true,
            unattended: true,
        });
        // The roster record reopened for the follow-up and settled again with its report.
        expect(listSubagentSessions()[0]).toMatchObject({ id: result.id, status: "completed", summary: "first pass done" });
    });

    it("send to a working child on a runtime with no steering seam refuses honestly", async () => {
        const gate = Promise.withResolvers<void>();
        const holdOpen = async function* (services: Services, input: AgentTurn): AsyncGenerator<AgentEvent> {
            void services;
            void input;
            await gate.promise;
            yield { kind: "done" };
        };
        const services = fakeServices();
        const result = await spawnChild(services, parent, { prompt: "go" }, holdOpen);
        if (!result.ok) {
            throw new Error(result.message);
        }
        const sent = await sendToChild(services, parent, result.id, "more", holdOpen);
        expect(sent).toMatchObject({ ok: false, message: expect.stringContaining("mid-turn") });
        gate.resolve();
        await settled(result.id);
    });
});

/* The SHELL door's gate (children.routes.ts): the persona decision is recorded at plan time as the supervisor
 * itself, so the route uses exactly what a tool call would have, and a conversation no qualifying turn ever
 * planned has nothing armed to use. */
describe("the shell door's arming", () => {
    const supervisor = (onSpawn: (prompt: string) => void): ChildSupervisor => ({
        spawn: async (spec) => {
            onSpawn(spec.prompt);
            return { ok: true, id: "sub-x" };
        },
        send: async () => ({ ok: true }),
        answer: async () => ({ ok: true }),
        pendingQuestion: () => undefined,
    });

    it("answers with exactly the supervisor a qualifying turn recorded", async () => {
        const calls: string[] = [];
        armSupervisor("conv-armed", supervisor((prompt) => calls.push(prompt)));
        const armed = supervisorFor("conv-armed");
        expect(armed).toBeDefined();
        await armed?.spawn({ prompt: "go" });
        expect(calls).toEqual(["go"]);
    });

    it("has nothing for a conversation no qualifying turn planned", () => {
        expect(supervisorFor("conv-never-planned")).toBeUndefined();
    });

    it("forgets every arming on reset, the daemon-death story", () => {
        armSupervisor("conv-armed", supervisor(() => {}));
        resetChildrenForTest();
        expect(supervisorFor("conv-armed")).toBeUndefined();
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
