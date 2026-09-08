import { type AgentEvent, type AgentTurn, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { listSubagentSessions, resetSubagents, waitForSubagent } from "./subagents.js";
import type { Services } from "../../composition.js";
import type { TurnFn } from "../../loops/loop-runner.js";
import { createRequest, resolveRequest } from "../tools/agent-requests.js";
// Two modules export a `TurnFn` and they are not the same shape: the loop pump's takes the services it runs
// against, a run's takes only the turn. `fakeTurn` below is the pump's; the parent stream further down is a
// run's, so it is imported under its own name rather than annotated with whichever was already in scope.
import { startTurnRun, turnRunOf, type TurnFn as RunTurnFn } from "../run/turn/turn-runs.js";
import { clearTurnTaint, conversationTaintSource, createTurnTaint, publishTurnTaint } from "../../guard/turn-taint.js";
import { answerChild, armSupervisor, pendingQuestionOf, resetChildrenForTest, sendToChild, spawnChild, supervisorFor, type ChildSupervisor } from "./children.js";

// Drives the spawn engine through its real entry point; defends the seam's promises (isolated unattended conversation,
// budgets enforced in the daemon, roster tracks the child's frames), not its plumbing.

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({ ...SandboxSettingsSchema.parse({}), ...over });

// The fleet a spawn can be placed onto; empty by default, so most tests place nothing and a spawn runs here as it
// always did.
interface FakeRunner {
    readonly id: string;
    readonly online: boolean;
    readonly cpus?: number;
    readonly inFlight?: number;
}

const fakeServices = (over: Partial<SandboxSettings> = {}, fleet: readonly FakeRunner[] = []): Services =>
    unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings(over) }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { append: async () => {} }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root: "/work" }),
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {}, error: () => {} }),
        config: unstubbed<Services["config"]>("config", {
            // Only the fields the scheduler's parity read touches; the rest throw by name instead of being invented.
            sandbox: unstubbed<Services["config"]["sandbox"]>("config.sandbox", {
                image: "ghcr.io/intentic/sandbox:2",
                channel: "stable",
                environmentHash: "",
            }),
        }),
        runners: unstubbed<Services["runners"]>("runners", { list: async () => fleet.map((runner) => ({ id: runner.id })) }),
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
        agents: unstubbed<Services["agents"]>("agents", {
            inFlightByRunner: () => new Map(fleet.flatMap((runner) => (runner.inFlight === undefined ? [] : [[runner.id, runner.inFlight] as const]))),
            // A held supervisor call mirrors its card here too; tests only need it reachable.
            observe: () => {},
        }),
    });

// `turns` collects what the pump was asked to run; `events` is what the child says back. The generator ending settles
// the record.
const fakeTurn = (turns: AgentTurn[], events: AgentEvent[] = [{ kind: "done" }]): TurnFn =>
    // eslint-disable-next-line require-yield
    async function* fake(_services, input: AgentTurn) {
        turns.push(input);
        yield* events;
    };

const parent = { conversationId: "conv-parent", cwd: "/work" };

// Uses the parent's own wait primitive, the only observation surface a real parent has.
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
        const result = await spawnChild(fakeServices(), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([], events));
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
        const result = await spawnChild(fakeServices(), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, holdAt);
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
        const result = await spawnChild(fakeServices(), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([], events));
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(listSubagentSessions()[0]).toMatchObject({ status: "failed", error: "no Cursor subscription connected" });
    });
});

// Every supervisor mutation consults the owner's rulebook and taint floor (guard/actions.ts childSpawn); a tainted
// parent needs explicit allowance, and a child beyond every gate marks the parent's own turn bit.
describe("the spawn rulebook and the floors", () => {
    it("a deny rule refuses every door's spawn, a per-provider hold names the owner", async () => {
        const denied = await spawnChild(fakeServices({ actionRules: { "agents.spawn": "deny" } }), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        expect(denied).toMatchObject({ ok: false, message: expect.stringContaining("refused") });
        const held = await spawnChild(
            fakeServices({ actionRules: { "agents.spawn.cursor": "hold" } }),
            parent,
            { prompt: "go", model: "claude-sonnet-4-6", provider: "cursor" },
            fakeTurn([]),
        );
        expect(held).toMatchObject({ ok: false, message: expect.stringContaining("owner") });
        // A per-provider hold doesn't reach a provider the owner didn't name.
        const other = await spawnChild(fakeServices({ actionRules: { "agents.spawn.cursor": "hold" } }), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
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
            const held = await spawnChild(fakeServices(), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
            expect(held).toMatchObject({ ok: false, message: expect.stringContaining("webchat") });
            const allowed = await spawnChild(fakeServices({ actionRules: { "agents.spawn": "allow" } }), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
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
            const result = await spawnChild(fakeServices(), parent, { prompt: "go", model: "claude-sonnet-4-6", provider: "pi" }, fakeTurn([]));
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

// A child's question is the parent's to answer, via the same request registry the child parked on; consent cards refuse
// by kind, so a parent can't approve its own child's action. `send` steers a working child or follows up a settled one.
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
        // The child's ask, as its runtime would raise it; the id rides the frame that follows.
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
        const result = await spawnChild(services, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, askThenFinish);
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        // The wait surfaces hand the parent the whole question, options included.
        expect(pendingQuestionOf(result.id)).toMatchObject({
            kind: "question",
            requestId,
            questions: [{ question: "Which port should the server bind?" }],
        });
        const answered = await answerChild(services, parent, result.id, { "Which port should the server bind?": ["8080"] });
        expect(answered.ok).toBe(true);
        // Settled with the parent's picks: a real answer, not the abort stand-in.
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
        const result = await spawnChild(fakeServices(), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, holdOnPermission);
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        // A consent card is not a question: the wait surfaces hand nothing to answer with.
        expect(pendingQuestionOf(result.id)).toBeUndefined();
        // A direct attempt refuses by kind, naming whose the card is.
        const refused = await answerChild(fakeServices(), parent, result.id, { anything: ["yes"] });
        expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("owner") });
        gate.resolve();
        await settled(result.id);
    });

    it("refuses a child waiting on nothing", async () => {
        const result = await spawnChild(fakeServices(), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        await expect(answerChild(fakeServices(), parent, result.id, {})).resolves.toMatchObject({ ok: false, message: expect.stringContaining("not waiting") });
    });

    // Only the parent that started a child may reach it (children.ts' security spine); asserted while the child is
    // live, since a settled child refuses from every door regardless and would prove nothing.
    it("refuses a stranger every door onto a child parked mid-turn, by parentage rather than by state", async () => {
        const { id: requestId, wait: parked } = createRequest("question", { kind: "question", requestId: "", cancelled: true });
        void parked(new AbortController().signal);
        const gate = Promise.withResolvers<void>();
        const turns: AgentTurn[] = [];
        const askThenFinish = async function* (services: Services, input: AgentTurn): AsyncGenerator<AgentEvent> {
            void services;
            turns.push(input);
            yield questionFrame(requestId);
            await gate.promise;
            yield { kind: "resolved", requestId };
            yield { kind: "done" };
        };
        const services = fakeServices();
        const result = await spawnChild(services, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, askThenFinish);
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        const stranger = { conversationId: "conv-other", cwd: "/work" };

        // The real parent can see the card, so the refusals below are about who's asking, not state.
        expect(pendingQuestionOf(result.id)).toMatchObject({ kind: "question", requestId });

        await expect(answerChild(services, stranger, result.id, { "Which port should the server bind?": ["8080"] })).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("No such child"),
        });
        await expect(sendToChild(services, stranger, result.id, "do something else", askThenFinish)).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("No such child"),
        });
        // The stranger's send started no turn; the child is still parked, unanswered.
        expect(turns).toHaveLength(1);
        expect(pendingQuestionOf(result.id)).toMatchObject({ kind: "question", requestId });

        gate.resolve();
        await settled(result.id);
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
        const result = await spawnChild(services, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, holdOpen);
        if (!result.ok) {
            throw new Error(result.message);
        }
        const sent = await sendToChild(services, parent, result.id, "more", holdOpen);
        expect(sent).toMatchObject({ ok: false, message: expect.stringContaining("mid-turn") });
        gate.resolve();
        await settled(result.id);
    });
});

// children.routes.ts' gate: the persona decision is recorded at plan time as the supervisor itself, so a conversation
// no qualifying turn planned has nothing armed.
describe("the shell door's arming", () => {
    const supervisor = (onSpawn: (prompt: string) => void): ChildSupervisor => ({
        spawn: async (spec) => {
            onSpawn(spec.prompt);
            return { ok: true, id: "sub-x" };
        },
        providers: async () => [],
        send: async () => ({ ok: true }),
        answer: async () => ({ ok: true }),
        pendingQuestion: () => undefined,
    });

    it("answers with exactly the supervisor a qualifying turn recorded", async () => {
        const calls: string[] = [];
        armSupervisor("conv-armed", supervisor((prompt) => calls.push(prompt)));
        const armed = supervisorFor("conv-armed");
        await armed?.spawn({ prompt: "go", provider: "claude", model: "claude-sonnet-4-6", });
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
        const first = await spawnChild(services, parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6", }, holdOpen);
        expect(first.ok).toBe(true);
        const second = await spawnChild(services, parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6", }, holdOpen);
        expect(second).toMatchObject({ ok: false, message: expect.stringContaining("already running") });
        gate.resolve();
        if (first.ok) {
            await settled(first.id);
        }
        const third = await spawnChild(services, parent, { prompt: "three", provider: "claude", model: "claude-sonnet-4-6", }, holdOpen);
        expect(third.ok).toBe(true);
        gate.resolve();
    });

    it("refuses past the lifetime budget", async () => {
        const services = fakeServices({ subagentsPerTurn: 1 });
        const first = await spawnChild(services, parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        expect(first.ok).toBe(true);
        if (first.ok) {
            await settled(first.id);
        }
        const second = await spawnChild(services, parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        expect(second).toMatchObject({ ok: false, message: expect.stringContaining("lifetime budget") });
    });

    // Guards the race the sequential tests above can't reach: two spawns reading the ledger before either writes it.
    it("holds the live ceiling against spawns that arrive together", async () => {
        const gate = Promise.withResolvers<void>();
        const holdOpen = async function* (services: Services, input: AgentTurn): AsyncGenerator<AgentEvent> {
            void services;
            void input;
            await gate.promise;
            yield { kind: "done" };
        };
        const services = fakeServices({ subagentsAtOnce: 1 });

        const results = await Promise.all([
            spawnChild(services, parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6", }, holdOpen),
            spawnChild(services, parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6", }, holdOpen),
            spawnChild(services, parent, { prompt: "three", provider: "claude", model: "claude-sonnet-4-6", }, holdOpen),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        for (const refused of results.filter((result) => !result.ok)) {
            expect(refused).toMatchObject({ message: expect.stringContaining("already running") });
        }
        gate.resolve();
    });

    // The live-seat budget is reserved before the child is assembled (read and write must be one synchronous step); an
    // exception before the turn starts must give it back, or a stranded seat refuses the parent forever.
    it("gives the seat back when the spawn throws before the turn starts", async () => {
        const services = fakeServices({ subagentsAtOnce: 1 });
        // Only the prompt explodes: provider and model are read first and gate admission before this path is reached.
        const exploding = {
            description: "a spec that cannot be read",
            provider: "claude",
            model: "claude-sonnet-4-6",
            get prompt(): string {
                throw new Error("boom");
            },
        } as unknown as Parameters<typeof spawnChild>[2];

        await expect(spawnChild(services, parent, exploding, fakeTurn([]))).rejects.toThrow("boom");

        // Proof: the next spawn fits, when a stranded seat under a ceiling of one would refuse it.
        const after = await spawnChild(services, parent, { prompt: "ok", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        expect(after.ok).toBe(true);
    });

    // Targets the lifetime counter: a live seat frees on settle, but N parallel spawns must still cost N against it.
    it("counts every concurrent spawn against the lifetime budget", async () => {
        const services = fakeServices({ subagentsAtOnce: 5, subagentsPerTurn: 2 });

        const results = await Promise.all([
            spawnChild(services, parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([])),
            spawnChild(services, parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([])),
            spawnChild(services, parent, { prompt: "three", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([])),
            spawnChild(services, parent, { prompt: "four", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([])),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(2);
        await Promise.all(results.map(async (result) => (result.ok ? settled(result.id) : undefined)));
        // Proves the concurrent pair was really recorded, not merely let through: a later spawn is refused too.
        const later = await spawnChild(services, parent, { prompt: "five", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        expect(later).toMatchObject({ ok: false, message: expect.stringContaining("lifetime budget") });
    });

    // Keyed by the child's own conversation id, since a child gets the spawn tool too.
    it("refuses a chain deeper than the owner's setting", async () => {
        const services = fakeServices({ subagentDepth: 1 });
        const first = await spawnChild(services, parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        if (!first.ok) {
            throw new Error(first.message);
        }
        const fromChild = await spawnChild(services, { conversationId: first.id, cwd: "/work" }, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        expect(fromChild).toMatchObject({ ok: false, message: expect.stringContaining("depth") });
        await settled(first.id);
    });
});

describe("placing a child on the fleet", () => {
    // Waits for the child to settle first: reading the turn immediately sees an empty array, so an absent placement
    // would pass on a turn that hadn't started.
    const placementOf = async (services: Services, spec: Parameters<typeof spawnChild>[2]): Promise<AgentTurn["placement"]> => {
        const turns: AgentTurn[] = [];
        const result = await spawnChild(services, parent, spec, fakeTurn(turns));
        expect(result.ok).toBe(true);
        await settled(result.ok ? result.id : "");
        return turns[0]?.placement;
    };

    // Lets a fan-out of many children spread across connected machines without choosing per agent.
    it("sends a child to a ready runner with no one asking", async () => {
        expect(await placementOf(fakeServices({}, [{ id: "rig", online: true }]), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", })).toEqual({ kind: "runner", id: "rig" });
    });

    it("keeps the work here when there is no fleet", async () => {
        expect(await placementOf(fakeServices(), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", })).toBeUndefined();
    });

    // Six slots used of eight cores counts as full; the free sandbox wins over waiting.
    it("keeps the work here when every machine is full", async () => {
        expect(await placementOf(fakeServices({}, [{ id: "rig", online: true, inFlight: 6 }]), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", })).toBeUndefined();
    });

    it("honours a machine the caller named over the one with more room", async () => {
        const fleet = [
            { id: "rig", online: true },
            { id: "other", online: true, cpus: 32 },
        ];
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", on: "rig" })).toEqual({ kind: "runner", id: "rig" });
        // Nobody asking gets the roomier machine, confirming the line above is a real preference.
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", })).toEqual({ kind: "runner", id: "other" });
    });

    // Only the Claude Code runtime family's credentials travel (runner-scheduler.credentialsTravel); a Cursor child
    // sent elsewhere dies on its first request, reading as a broken fleet rather than a missing login.
    it("keeps a child here when its runtime authenticates from the machine it runs on", async () => {
        const fleet = [{ id: "rig", online: true }];
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", model: "claude-sonnet-4-6", provider: "cursor" })).toBeUndefined();
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", model: "claude-sonnet-4-6", provider: "codex" })).toBeUndefined();
        // The same provider under the claude-code harness routes through the translator, so it does travel.
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", model: "claude-sonnet-4-6", provider: "codex", harness: "claude-code" })).toEqual({
            kind: "runner",
            id: "rig",
        });
    });

    it("still honours a machine named for a runtime that authenticates locally: the person knows their fleet", async () => {
        const placed = await placementOf(fakeServices({}, [{ id: "rig", online: true }]), { prompt: "go", model: "claude-sonnet-4-6", provider: "cursor", on: "rig" });
        expect(placed).toEqual({ kind: "runner", id: "rig" });
    });

    it("`here` pins a child to this sandbox even with a fleet standing by", async () => {
        expect(await placementOf(fakeServices({}, [{ id: "rig", online: true }]), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", on: "here" })).toBeUndefined();
    });
});

// Same floor fires either way; what differs is whether a live turn exists to draw a card on. Every other test here has
// none, which is the detached `agents` shell case and is still the correct refusal.
describe("a held supervisor call asks the owner where there is one to ask", () => {
    // Keeps a parent turn open for the test via the real pump, not a stand-in, so `turnRunOf` finds a live stream a
    // card can actually be raised into.
    const liveParent = (): { release: () => void } => {
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        // eslint-disable-next-line require-yield
        const forever: RunTurnFn = async function* pump() {
            await held;
        };
        startTurnRun(forever, { conversationId: parent.conversationId, prompt: "parent" } as AgentTurn & { conversationId: string });
        return { release };
    };

    // The card's requestId, off the parent's own frame log, exactly what a client would answer with.
    const cardOn = async (): Promise<string> => {
        const run = turnRunOf(parent.conversationId);
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const card = run?.rows.find((row) => row.permission !== undefined)?.permission;
            if (card !== undefined) {
                return card.requestId;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("no permission card was raised on the parent's turn");
    };

    it("raises a card on the parent's turn and runs the spawn once it is allowed", async () => {
        const live = liveParent();
        try {
            const spawning = spawnChild(fakeServices({ actionRules: { "agents.spawn": "hold" } }), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
            const requestId = await cardOn();
            // Names the move and provider, so answering it isn't a guess about what it does.
            const card = turnRunOf(parent.conversationId)?.rows.find((row) => row.permission !== undefined)?.permission;
            expect(card).toMatchObject({ toolName: "agents.spawn", title: "Start a child agent on claude?", displayName: "Start it" });
            // No always-allow offered: nothing here would remember one.
            expect(card).not.toHaveProperty("alwaysLabel");

            expect(resolveRequest({ kind: "permission", requestId, decision: "once" })).toBe("settled");
            const result = await spawning;
            expect(result.ok).toBe(true);
            if (result.ok) {
                await settled(result.id);
            }
            // Settles on the parent's run, so a client stops drawing the card as live.
            expect(turnRunOf(parent.conversationId)?.rows.find((row) => row.permission !== undefined)?.permission?.status).toBe("allowed");
        } finally {
            live.release();
        }
    });

    it("a denial refuses the spawn and tells the model not to retry", async () => {
        const live = liveParent();
        try {
            const spawning = spawnChild(fakeServices({ actionRules: { "agents.spawn": "hold" } }), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
            const requestId = await cardOn();
            resolveRequest({ kind: "permission", requestId, decision: "deny" });
            const result = await spawning;
            expect(result).toMatchObject({ ok: false, message: expect.stringContaining("declined") });
            expect(result.ok === false && result.message).toContain("Do not retry");
        } finally {
            live.release();
        }
    });

    // With no live turn to draw a card on (a backgrounded shell, an ended turn), it still refuses and names which case
    // it is.
    it("with no live turn there is nowhere to ask, and it says so", async () => {
        const held = await spawnChild(fakeServices({ actionRules: { "agents.spawn": "hold" } }), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", }, fakeTurn([]));
        expect(held).toMatchObject({ ok: false, message: expect.stringContaining("outside a live turn") });
        expect(held.ok === false && held.message).toContain("agents.spawn");
    });
});
