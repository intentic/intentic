import { type AgentEvent, type AgentTurn, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { listSubagentSessions, resetSubagents, waitForSubagent } from "../agent/subagents.js";
import type { Services } from "../composition.js";
import type { TurnFn } from "../loops/loop-runner.js";
import { createRequest, resolveRequest } from "../agent/agent-requests.js";
// Two modules export a `TurnFn` and they are not the same shape: the loop pump's takes the services it runs
// against, a run's takes only the turn. `fakeTurn` below is the pump's; the parent stream further down is a
// run's, so it is imported under its own name rather than annotated with whichever was already in scope.
import { startTurnRun, turnRunOf, type TurnFn as RunTurnFn } from "../agent/turn-runs.js";
import { clearTurnTaint, conversationTaintSource, createTurnTaint, publishTurnTaint } from "../guard/turn-taint.js";
import { answerChild, armSupervisor, pendingQuestionOf, resetChildrenForTest, sendToChild, spawnChild, supervisorFor, type ChildSupervisor } from "./children.js";

/* The spawn engine, driven through its real entry point with a fake turn generator, the loop pump's own test
 * shape. What the suite defends is the seam's PROMISES rather than its plumbing: a child is an ordinary
 * isolated unattended conversation on the provider the spec names; the budgets are enforced in the daemon;
 * and the roster record a parent's `wait` parks on moves with the child's own frames. */

const settings = (over: Partial<SandboxSettings> = {}): SandboxSettings => ({ ...SandboxSettingsSchema.parse({}), ...over });

/* The fleet a spawn is placed onto (runners/runner-scheduler.ts). Empty by default, which is every sandbox
 * with no runners and therefore every test that is not about placement: with nothing to spread onto, a spawn
 * runs here exactly as it always did. */
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
            // Nested seam: the scheduler's parity read touches three of this object's dozen fields, and the
            // helper's job is to make the other nine throw by name rather than be quietly invented here.
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
                          image: "ghcr.io/intentic/sandbox:2",
                          channel: "stable",
                          facts: { cpus: found.cpus ?? 8, memoryMb: 32_768, freeDiskMb: 100_000, load: 0.1 },
                      };
            },
            // The summaries the scheduler reads also carry drift lines; these runners never declared a shape,
            // which is a real state (a hand-started runner) and costs nothing the placement tests care about.
            definitionToml: () => undefined,
        }),
        agents: unstubbed<Services["agents"]>("agents", {
            inFlightByRunner: () => new Map(fleet.flatMap((runner) => (runner.inFlight === undefined ? [] : [[runner.id, runner.inFlight] as const]))),
            // A held supervisor call raises a card and mirrors it here, which is what lights the fleet's
            // "needs you" lane; the tests only care that it is reachable.
            observe: () => {},
        }),
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

    it("refuses a child waiting on nothing", async () => {
        const result = await spawnChild(fakeServices(), parent, { prompt: "go" }, fakeTurn([]));
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        await expect(answerChild(fakeServices(), parent, result.id, {})).resolves.toMatchObject({ ok: false, message: expect.stringContaining("not waiting") });
    });

    /* ONLY THE PARENT THAT STARTED A CHILD MAY REACH IT, which children.ts calls the security spine of the
     * whole surface, and it has to be asserted WHILE there is something to reach. Against a settled child every
     * door refuses anyway ("not waiting on anything"), so `ok: false` alone proves nothing: delete the parentage
     * check and a stranger still gets `ok: false`, from the wrong branch, and the suite stays green.
     *
     * So the child is parked on a real question first, and the refusals are read by their REASON. What is at
     * stake is a cross-conversation channel into a live turn: `answer` settles a card the child is blocked on,
     * `send` injects text straight into it, and `pendingQuestion` would hand a stranger the full question. */
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
        const result = await spawnChild(services, parent, { prompt: "go" }, askThenFinish);
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        const stranger = { conversationId: "conv-other", cwd: "/work" };

        // The real parent CAN see the card — so the refusals below are about who is asking, not about state.
        expect(pendingQuestionOf(result.id)).toMatchObject({ kind: "question", requestId });

        await expect(answerChild(services, stranger, result.id, { "Which port should the server bind?": ["8080"] })).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("No such child"),
        });
        await expect(sendToChild(services, stranger, result.id, "do something else", askThenFinish)).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("No such child"),
        });
        // The stranger's send started no turn, and its answer settled nothing: the child is still parked.
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

    /* THE CAP HAS TO HOLD AGAINST TWO SPAWNS AT ONCE, which is the shape a runaway actually arrives in: two
     * tool_use blocks in one assistant message, or a turn backgrounding two `agents spawn` shells, each landing
     * on POST /children/spawn independently. Every case above this one awaits its first spawn before starting
     * the second, so all of them pass against a ledger that is read in one turn of the event loop and written
     * in another — which is what it used to be. Both calls read {live: 0}, both cleared a ceiling of one. */
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
            spawnChild(services, parent, { prompt: "one" }, holdOpen),
            spawnChild(services, parent, { prompt: "two" }, holdOpen),
            spawnChild(services, parent, { prompt: "three" }, holdOpen),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(1);
        for (const refused of results.filter((result) => !result.ok)) {
            expect(refused).toMatchObject({ message: expect.stringContaining("already running") });
        }
        gate.resolve();
    });

    /* A CLAIMED SEAT THAT NEVER BECAME A TURN HAS TO COME BACK, however the spawn ended.
     *
     * The budget is reserved BEFORE the child is assembled, because reading and writing it in one synchronous
     * step is the only thing that makes it a cap (the two tests around this one). The cost of taking it early
     * is that an exception on the way to the turn strands it — and a stranded live seat is permanent: it
     * lowers subagentsAtOnce by one for the life of the conversation, and the parent is eventually refused
     * forever over children that do not exist. A throwing spec is the cheapest way to reach that path. */
    it("gives the seat back when the spawn throws before the turn starts", async () => {
        const services = fakeServices({ subagentsAtOnce: 1 });
        const exploding = {
            description: "a spec that cannot be read",
            get prompt(): string {
                throw new Error("boom");
            },
        } as unknown as Parameters<typeof spawnChild>[2];

        await expect(spawnChild(services, parent, exploding, fakeTurn([]))).rejects.toThrow("boom");

        // The proof is that the next spawn fits: under a ceiling of one, a stranded seat would refuse it.
        const after = await spawnChild(services, parent, { prompt: "ok" }, fakeTurn([]));
        expect(after.ok).toBe(true);
    });

    // The same race against the LIFETIME counter, which is the one that stays wrong: a live seat is given back
    // when the child settles, but a turn that was never counted is never counted, so N parallel spawns used to
    // cost 1 against a budget meant to meter N.
    it("counts every concurrent spawn against the lifetime budget", async () => {
        const services = fakeServices({ subagentsAtOnce: 5, subagentsPerTurn: 2 });

        const results = await Promise.all([
            spawnChild(services, parent, { prompt: "one" }, fakeTurn([])),
            spawnChild(services, parent, { prompt: "two" }, fakeTurn([])),
            spawnChild(services, parent, { prompt: "three" }, fakeTurn([])),
            spawnChild(services, parent, { prompt: "four" }, fakeTurn([])),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(2);
        await Promise.all(results.map(async (result) => (result.ok ? settled(result.id) : undefined)));
        // The lifetime budget is spent, so a later sequential spawn is refused too: the concurrent pair really
        // was recorded, rather than merely being let through and forgotten.
        const later = await spawnChild(services, parent, { prompt: "five" }, fakeTurn([]));
        expect(later).toMatchObject({ ok: false, message: expect.stringContaining("lifetime budget") });
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

/* ---- where a spawned child runs (the fleet) ---- */

describe("placing a child on the fleet", () => {
    /* Every assertion here waits for the child to SETTLE first. A spawn hands its turn to a detached pump and
     * returns immediately, so reading the recorded turn any earlier reads an empty array, and an assertion
     * that the placement is absent would pass on a turn that had not started. */
    const placementOf = async (services: Services, spec: Parameters<typeof spawnChild>[2]): Promise<AgentTurn["placement"]> => {
        const turns: AgentTurn[] = [];
        const result = await spawnChild(services, parent, spec, fakeTurn(turns));
        expect(result.ok).toBe(true);
        await settled(result.ok ? result.id : "");
        return turns[0]?.placement;
    };

    /* THE POINT OF THE WHOLE FEATURE, in one assertion: a turn that fans out spreads onto the machines the
     * owner connected without anybody choosing per agent, which is the only way thirty of them get placed. */
    it("sends a child to a ready runner with no one asking", async () => {
        expect(await placementOf(fakeServices({}, [{ id: "rig", online: true }]), { prompt: "go" })).toEqual({ kind: "runner", id: "rig" });
    });

    it("keeps the work here when there is no fleet", async () => {
        expect(await placementOf(fakeServices(), { prompt: "go" })).toBeUndefined();
    });

    // Six slots on eight cores, all taken: the sandbox that was free all along beats waiting for one.
    it("keeps the work here when every machine is full", async () => {
        expect(await placementOf(fakeServices({}, [{ id: "rig", online: true, inFlight: 6 }]), { prompt: "go" })).toBeUndefined();
    });

    it("honours a machine the caller named over the one with more room", async () => {
        const fleet = [
            { id: "rig", online: true },
            { id: "other", online: true, cpus: 32 },
        ];
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", on: "rig" })).toEqual({ kind: "runner", id: "rig" });
        // Nobody asking gets the roomier machine, which is what makes the line above a real preference.
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go" })).toEqual({ kind: "runner", id: "other" });
    });

    /* CROSS-PROVIDER CHILDREN ARE THE POINT OF THE SPAWN ENGINE, and half of them cannot travel: only the
     * Claude Code runtime's family spends the origin's credentials (runner-scheduler.credentialsTravel).
     * A Cursor child sent to a machine that has never signed into Cursor dies on its first request, which
     * reads as a broken fleet rather than as a login that was never there. */
    it("keeps a child here when its runtime authenticates from the machine it runs on", async () => {
        const fleet = [{ id: "rig", online: true }];
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", provider: "cursor" })).toBeUndefined();
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", provider: "codex" })).toBeUndefined();
        // The same provider UNDER the Claude Code harness is routed through the translator the parent
        // re-serves, so that one travels.
        expect(await placementOf(fakeServices({}, fleet), { prompt: "go", provider: "codex", harness: "claude-code" })).toEqual({
            kind: "runner",
            id: "rig",
        });
    });

    it("still honours a machine named for a runtime that authenticates locally: the person knows their fleet", async () => {
        const placed = await placementOf(fakeServices({}, [{ id: "rig", online: true }]), { prompt: "go", provider: "cursor", on: "rig" });
        expect(placed).toEqual({ kind: "runner", id: "rig" });
    });

    it("`here` pins a child to this sandbox even with a fleet standing by", async () => {
        expect(await placementOf(fakeServices({}, [{ id: "rig", online: true }]), { prompt: "go", on: "here" })).toBeUndefined();
    });
});

/* WHERE A HOLD IS ASKED RATHER THAN REFUSED, which is the difference between a rule the owner can answer and a
 * sentence the model reads out to nobody.
 *
 * The floor fires on exactly the same input in both cases; what changes is whether there is a live turn to draw
 * a card in. Every other test in this file runs without one, which is why they all see the refusal — that is
 * the detached `agents` shell, and it is still correct there. */
describe("a held supervisor call asks the owner where there is one to ask", () => {
    // A parent turn that stays open for as long as the test needs, so `turnRunOf` finds a live stream. The
    // real pump, not a stand-in: a card raised into anything else would prove nothing about the wiring.
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

    // The card's requestId, off the parent's own frame log: exactly what a client would answer with.
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
            const spawning = spawnChild(fakeServices({ actionRules: { "agents.spawn": "hold" } }), parent, { prompt: "go" }, fakeTurn([]));
            const requestId = await cardOn();
            // The card names the move and the provider, so answering it is not a guess about what it would do.
            const card = turnRunOf(parent.conversationId)?.rows.find((row) => row.permission !== undefined)?.permission;
            expect(card).toMatchObject({ toolName: "agents.spawn", title: "Start a child agent on claude?", displayName: "Start it" });
            // No always-allow offered, because nothing here would remember one.
            expect(card).not.toHaveProperty("alwaysLabel");

            expect(resolveRequest({ kind: "permission", requestId, decision: "once" })).toBe(true);
            const result = await spawning;
            expect(result.ok).toBe(true);
            if (result.ok) {
                await settled(result.id);
            }
            // The card's row settles on the parent's run, which is what stops a client drawing the card as live.
            expect(turnRunOf(parent.conversationId)?.rows.find((row) => row.permission !== undefined)?.permission?.status).toBe("allowed");
        } finally {
            live.release();
        }
    });

    it("a denial refuses the spawn and tells the model not to retry", async () => {
        const live = liveParent();
        try {
            const spawning = spawnChild(fakeServices({ actionRules: { "agents.spawn": "hold" } }), parent, { prompt: "go" }, fakeTurn([]));
            const requestId = await cardOn();
            resolveRequest({ kind: "permission", requestId, decision: "deny" });
            const result = await spawning;
            expect(result).toMatchObject({ ok: false, message: expect.stringContaining("declined") });
            expect(result.ok === false && result.message).toContain("Do not retry");
        } finally {
            live.release();
        }
    });

    /* THE ONE THE OLD CODE GOT RIGHT AND MUST KEEP GETTING RIGHT: a call with no live turn behind it (a
     * backgrounded `agents` shell, a turn that has already ended) has nowhere to draw a card, so it still
     * refuses — and now says which of the two situations it is in. */
    it("with no live turn there is nowhere to ask, and it says so", async () => {
        const held = await spawnChild(fakeServices({ actionRules: { "agents.spawn": "hold" } }), parent, { prompt: "go" }, fakeTurn([]));
        expect(held).toMatchObject({ ok: false, message: expect.stringContaining("outside a live turn") });
        expect(held.ok === false && held.message).toContain("agents.spawn");
    });
});
