import {
    type AgentEvent,
    type AgentTurn,
    agentWordsOf,
    type LimitPolicy,
    type SandboxSettings,
    type SubagentSession,
    withRuntimeDefaults,
} from "@intentic/sandbox-contract";
import type { MemoryReading } from "@intentic/constants/memory-room";
import { listSubagentSessions, noteSubagentTask, resetSubagents, type SubagentWaitOutcome, waitForSubagent } from "./subagents.js";
import type { Services } from "../../composition.js";
import { spawnServices } from "../../harness/spawn-services.testing.js";
import { startTurnRun } from "../run/turn/turn-runs.js";
import { classifyFailure } from "../run/frames/classify-failure.js";
import { conversationIdentity, mainTreePlacement, placedTurn } from "../run/placement/turn-placement.js";
import { breakPolicyFor } from "../run/turn/turn-resume.js";
import { clearTurnTaint, conversationTaintSource, createTurnTaint, publishTurnTaint } from "../../guard/turn-taint.js";
import { unstubbed } from "@intentic/testing";
import { reportChildTurn } from "./child-report.js";
import { childLandingWords } from "./child-lands.js";
import {
    adoptChildTurn,
    answerChild,
    armSupervisor,
    cancelChild,
    childReportOf,
    type ChildSpawnSpec,
    mergeChild,
    pendingQuestionOf,
    resetChildrenForTest,
    sendToChild,
    spawnChild,
    supervisorFor,
    type ChildSupervisor,
} from "./children.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import type { Fleet } from "../../conversations/registry/agents-registry.js";
import { conversationProfile, type Postures } from "../../conversations/registry/agents-store.js";
import { createDomainEvents, type DomainEventMap } from "../../seams/domain-events.js";
import type { RoutedTurn, TurnInput, TurnStarter } from "../../seams/turn-starter.js";
import { beginTurn, conversationEntry, drivenBy, fakeTurns, memoryFleet } from "../../testing.js";

// One fleet's actors for every spawn here, and the cards parked in them: what a parent's own wait and answer read.
const actors = memoryFleet().conversations;
const cards = parkedCards(actors);

// Drives the spawn engine through its real entry point; defends the seam's promises (isolated unattended conversation,
// budgets enforced in the daemon, roster tracks the child's frames), not its plumbing.

// `turns` collects what the pump was asked to run; `events` is what the child says back. The generator ending settles
// the record.
const fakeTurn = (turns: TurnInput[], events: AgentEvent[] = [{ kind: "done" }]): TurnStarter["stream"] =>
    // eslint-disable-next-line require-yield
    async function* fake(input: TurnInput) {
        turns.push(input);
        yield* events;
    };

const parent = { conversationId: "conv-parent", cwd: "/work" };

// Uses the parent's own wait primitive, the only observation surface a real parent has.
const settled = (id: string): Promise<unknown> =>
    waitForSubagent(actors, parent.conversationId, { target: id, until: ["finished"], timeoutMs: 5_000 });

// A runtime that says nothing and ends.
async function* doneAtOnce(): AsyncGenerator<AgentEvent> {
    yield { kind: "done" };
}

// The conversation's side of a child's turn as the daemon's own turn body takes it (stream-agent.ts), for the suites
// that read what a child's conversation opened with: the turn opens it on the registry, every frame its runtime says
// folds into the conversation's actor, and it settles.
const conversationTurn = (fleet: Fleet, runtime: (input: RoutedTurn) => AsyncIterable<AgentEvent> = doneAtOnce): TurnStarter["stream"] =>
    async function* opened(input) {
        const conversationId = input.conversationId ?? "";
        await beginTurn(fleet.conversations, conversationIdentity(input, conversationId, { isolated: true, runner: undefined }), Date.now());
        yield* placedTurn(
            fleet.conversations,
            conversationId,
            mainTreePlacement(() => runtime(withRuntimeDefaults(input))),
        );
    };

// The daemon a spawn sees, over a real fleet: its children's conversations open on the fleet's registry, in its actors.
const fleetServices = (fleet: Fleet, over: Partial<SandboxSettings>, body: TurnStarter["stream"]): Services =>
    drivenBy(unstubbed<Services>("services", { ...spawnServices(over, [], fleet.conversations), agents: fleet.agents }), body);

// The parent's wait on one child of a fleet's, as a real parent reads it.
const finishedIn = (fleet: Fleet, id: string): Promise<SubagentWaitOutcome> =>
    waitForSubagent(fleet.conversations, parent.conversationId, { target: id, until: ["finished"], timeoutMs: 5_000 });

beforeEach(() => {
    resetSubagents(actors);
    resetChildrenForTest(actors);
});

describe("what a child is", () => {
    it("runs as an isolated, unattended conversation on the provider the spec names", async () => {
        const turns: AgentTurn[] = [];
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn(turns)), parent, {
            prompt: "Port the parser to zig",
            provider: "cursor",
            model: "composer-2.5",
        });
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
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn([], [])), parent, {
            prompt: "Port the parser",
            description: "Port the parser",
            provider: "cursor",
            model: "composer-2.5",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        expect(listSubagentSessions(actors)[0]).toMatchObject({
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

// Read off the registry the child's first turn opens its conversation on, which is what the card and the resume pass
// both read. Nobody watches a child while its parent waits on it, so a spent allowance must not park it for a person's
// press: under a sandbox that waits, the child's own conversation answers that ending by sending the turn again.
describe("what a child's conversation opens with", () => {
    const opened = async (over: Partial<SandboxSettings>, spec: ChildSpawnSpec) => {
        const fleet = memoryFleet();
        await fleet.agents.init();
        const result = await spawnChild(fleetServices(fleet, over, conversationTurn(fleet)), parent, spec);
        if (!result.ok) {
            throw new Error(result.message);
        }
        await finishedIn(fleet, result.id);
        return { entry: fleet.agents.entry(result.id), summary: fleet.agents.get(result.id) };
    };
    const go = { prompt: "Review the audit of batch 24", provider: "codex", model: "gpt-5.1-codex" } as const;

    // Under `resend` or `move` it inherits, so the card shows the sandbox's answer and follows the owner changing it.
    const answers: [LimitPolicy, string, Postures, LimitPolicy | undefined][] = [
        ["wait", "a re-run of its own", { limit: "resend" }, "resend"],
        ["resend", "nothing of its own", {}, undefined],
        ["move", "nothing of its own", {}, undefined],
    ];
    it.each(answers)(
        "under a sandbox answering a spent allowance with %s, it opens answering with %s",
        async (limitPolicy, _said, postures, shown) => {
            const { entry, summary } = await opened({ limitPolicy }, go);
            expect(entry?.postures).toEqual(postures);
            expect(summary?.limitPolicy).toBe(shown);
        },
    );

    // Six children of one parent once all read "testaudit picks": the naming pass had renamed the parent's own words.
    it("is titled by the parent's description as a name the naming pass keeps, else by its prompt's head for that pass to name", async () => {
        expect((await opened({}, { ...go, description: "Test audit reviewer, batch 24" })).entry?.social.title).toEqual({
            text: "Test audit reviewer, batch 24",
            source: "model",
        });
        expect((await opened({}, go)).entry?.social.title).toEqual({ text: "Review the audit of batch 24", source: "derived" });
    });

    // A first turn can end before it opens its conversation (a runner nobody paired refuses it there); the follow-up that
    // opens it then opens it as the spawn would have.
    it("opens as the spawn would have when a follow-up is the turn that opens it", async () => {
        const fleet = memoryFleet();
        await fleet.agents.init();
        const opening = conversationTurn(fleet);
        let calls = 0;
        const body: TurnStarter["stream"] = async function* firstRefused(input, signal) {
            calls += 1;
            if (calls === 1) {
                yield { kind: "error", message: 'No runner named "rig" is paired with this sandbox.' };
                yield { kind: "done" };
                return;
            }
            yield* opening(input, signal);
        };
        const services = fleetServices(fleet, {}, body);
        const result = await spawnChild(services, parent, { ...go, description: "Test audit reviewer, batch 24" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await finishedIn(fleet, result.id);
        expect(fleet.agents.entry(result.id)).toBeUndefined();

        expect(await sendToChild(services, parent, result.id, "Try it here instead.")).toMatchObject({ ok: true });
        await finishedIn(fleet, result.id);
        expect(fleet.agents.entry(result.id)).toMatchObject({
            postures: { limit: "resend" },
            social: { title: { text: "Test audit reviewer, batch 24", source: "model" } },
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
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn([], events)), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(listSubagentSessions(actors)[0]).toMatchObject({ status: "completed", summary: "Done: the parser now handles nested arrays." });
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
        const holdAt = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            void input;
            yield question;
            await gate.promise;
            yield { kind: "resolved", requestId: "q1" };
            yield { kind: "done" };
        };
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), holdAt), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        const blocked = await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        expect(blocked).toMatchObject({ outcome: "blocked", matched: { summary: "Which port should the server bind?" } });
        gate.resolve();
        await settled(result.id);
        expect(listSubagentSessions(actors)[0]?.status).toBe("completed");
    });

    it("settles a turn that errored as failed, keeping the error", async () => {
        const events: AgentEvent[] = [{ kind: "error", message: "no Cursor subscription connected" }, { kind: "done" }];
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn([], events)), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(listSubagentSessions(actors)[0]).toMatchObject({ status: "failed", error: "no Cursor subscription connected" });
    });
});

// Every supervisor mutation consults the owner's rulebook and taint floor (guard/actions.ts childSpawn); a tainted
// parent needs explicit allowance, and a child beyond every gate marks the parent's own turn bit.
describe("the spawn rulebook and the floors", () => {
    it("a deny rule refuses every door's spawn, a per-provider hold names the owner", async () => {
        const denied = await spawnChild(drivenBy(spawnServices({ actionRules: { "agents.spawn": "deny" } }, [], actors), fakeTurn([])), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        expect(denied).toMatchObject({ ok: false, message: expect.stringContaining("refused") });
        const held = await spawnChild(drivenBy(spawnServices({ actionRules: { "agents.spawn.cursor": "hold" } }, [], actors), fakeTurn([])), parent, {
            prompt: "go",
            model: "claude-sonnet-4-6",
            provider: "cursor",
        });
        expect(held).toMatchObject({ ok: false, message: expect.stringContaining("owner") });
        // A per-provider hold doesn't reach a provider the owner didn't name.
        const other = await spawnChild(
            drivenBy(spawnServices({ actionRules: { "agents.spawn.cursor": "hold" } }, [], actors), fakeTurn([])),
            parent,
            { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" },
        );
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
            const held = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn([])), parent, {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
            });
            expect(held).toMatchObject({ ok: false, message: expect.stringContaining("webchat") });
            const allowed = await spawnChild(
                drivenBy(spawnServices({ actionRules: { "agents.spawn": "allow" } }, [], actors), fakeTurn([])),
                parent,
                { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" },
            );
            expect(allowed.ok).toBe(true);
            if (allowed.ok) {
                await settled(allowed.id);
                const sent = await sendToChild(drivenBy(spawnServices({}, [], actors), fakeTurn([])), parent, allowed.id, "more");
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
            const result = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn([])), parent, {
                prompt: "go",
                model: "claude-sonnet-4-6",
                provider: "pi",
            });
            expect(result.ok).toBe(true);
            expect(conversationTaintSource(parent.conversationId)).toBe("agent:pi");
            if (result.ok) {
                await settled(result.id);
                // Every later move is held, and the parent is told why in words it can act on, not a bare source key.
                expect(await sendToChild(drivenBy(spawnServices({}, [], actors), fakeTurn([])), parent, result.id, "more")).toEqual({
                    ok: false,
                    message:
                        "Held for the owner: this turn has taken in content from outside (the report of a subagent on pi, a runtime with no permission rules of its own), and a subagent would spend the owner's accounts on its say-so. This call arrived outside a live turn, so there was nowhere to ask them. Ask in chat; they can also set the agents.spawn action rule.",
                });
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
        const { id: requestId, wait: parked } = cards.create("question", { kind: "question", requestId: "", cancelled: true });
        const asked = parked(new AbortController().signal);
        const gate = Promise.withResolvers<void>();
        const askThenFinish = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            void input;
            yield questionFrame(requestId);
            await gate.promise;
            yield { kind: "resolved", requestId };
            yield { kind: "delta", text: "Bound to 8080." };
            yield { kind: "text_end" };
            yield { kind: "done" };
        };
        const services = spawnServices({}, [], actors);
        const result = await spawnChild(drivenBy(services, askThenFinish), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        // The wait surfaces hand the parent the whole question, options included.
        expect(pendingQuestionOf(actors, result.id)).toMatchObject({
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
        expect(listSubagentSessions(actors)[0]).toMatchObject({ status: "completed", summary: "Bound to 8080." });
    });

    // A parent with no live turn and no wait parked hears of its child's question only by being woken: otherwise the
    // child sits blocked, holding its seat, until a person happens to look.
    describe("a parked question wakes a parent that is not waiting", () => {
        const told: string[] = [];
        beforeEach(() => {
            told.length = 0;
        });
        // The parent idle: it has a record and a profile to continue, no live turn, and what reaches it is kept above.
        const idleParent = (stream: TurnStarter["stream"]): Services => {
            const driven = drivenBy(spawnServices({}, [], actors), stream);
            return unstubbed<Services>("services", {
                ...driven,
                agents: unstubbed<Services["agents"]>("agents", {
                    entry: (id: string) => (id === parent.conversationId ? conversationEntry({ id }) : undefined),
                }),
                turns: {
                    ...driven.turns,
                    say: async (said) => {
                        told.push(said.turn.prompt);
                        return { delivered: "started", run: "run-parent" };
                    },
                },
            });
        };
        // A child that parks on `card` and stays parked until `gate` opens.
        const parksOn = (card: AgentEvent, gate: Promise<void>) =>
            async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
                void input;
                yield card;
                await gate;
                yield { kind: "resolved", requestId: "requestId" in card ? card.requestId : "" };
                yield { kind: "done" };
            };
        // Polls until `ready` holds or a bound passes, so an assertion never races the detached child turn.
        const until = async (ready: () => boolean): Promise<void> => {
            for (let attempt = 0; attempt < 200 && !ready(); attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
        };

        it("is told the question and how to answer it, once: a later wait on any child does not hand the same move back", async () => {
            const gate = Promise.withResolvers<void>();
            const result = await spawnChild(idleParent(parksOn(questionFrame("q-1"), gate.promise)), parent, {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
            });
            if (!result.ok) {
                throw new Error(result.message);
            }
            await until(() => told.length > 0);
            expect(told).toHaveLength(1);
            expect(told[0]).toContain(`Your subagent \`${result.id}\``);
            expect(told[0]).toContain("Which port should the server bind?");
            expect(told[0]).toContain(`answer(child: "${result.id}"`);
            // Reported by the wake, so a wait on "any" has nothing new to say about it.
            await expect(waitForSubagent(actors, parent.conversationId, { until: ["blocked"], timeoutMs: 50 })).resolves.toMatchObject({
                outcome: "timeout",
            });
            gate.resolve();
            await settled(result.id);
        });

        it("is not woken for a permission or plan card: those are the owner's to answer", async () => {
            const consents: readonly AgentEvent[] = [
                { kind: "permission", requestId: "p-1", toolName: "Bash", title: "Run rm -rf build" },
                { kind: "plan", requestId: "plan-1", text: "do it" },
            ];
            for (const card of consents) {
                const gate = Promise.withResolvers<void>();
                const result = await spawnChild(idleParent(parksOn(card, gate.promise)), parent, {
                    prompt: "go",
                    provider: "claude",
                    model: "claude-sonnet-4-6",
                });
                if (!result.ok) {
                    throw new Error(result.message);
                }
                await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
                gate.resolve();
                await settled(result.id);
            }
            expect(told).toEqual([]);
        });

        it("is not woken when a wait it parked on that child already took the question", async () => {
            const gate = Promise.withResolvers<void>();
            const start = Promise.withResolvers<void>();
            const body = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
                await start.promise;
                yield* parksOn(questionFrame("q-2"), gate.promise)(input);
            };
            const result = await spawnChild(idleParent(body), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
            if (!result.ok) {
                throw new Error(result.message);
            }
            const waited = waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
            start.resolve();
            await expect(waited).resolves.toMatchObject({ outcome: "blocked", matched: { summary: "Which port should the server bind?" } });
            gate.resolve();
            await settled(result.id);
            expect(told).toEqual([]);
        });
    });

    it("refuses to answer a consent card, by kind, with the owner named", async () => {
        const gate = Promise.withResolvers<void>();
        const holdOnPermission = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            void input;
            yield { kind: "permission", requestId: "p1", toolName: "Bash", title: "Run rm -rf build" };
            await gate.promise;
            yield { kind: "done" };
        };
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), holdOnPermission), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        // A consent card is not a question: the wait surfaces hand nothing to answer with.
        expect(pendingQuestionOf(actors, result.id)).toBeUndefined();
        // A direct attempt refuses by kind, naming whose the card is.
        const refused = await answerChild(spawnServices({}, [], actors), parent, result.id, { anything: ["yes"] });
        expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("owner") });
        gate.resolve();
        await settled(result.id);
    });

    it("refuses a child waiting on nothing", async () => {
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn([])), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        await expect(answerChild(spawnServices({}, [], actors), parent, result.id, {})).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("not waiting"),
        });
    });

    // Only the parent that started a child may reach it (children.ts' security spine); asserted while the child is
    // live, since a settled child refuses from every door regardless and would prove nothing.
    it("refuses a stranger every door onto a child parked mid-turn, by parentage rather than by state", async () => {
        const { id: requestId, wait: parked } = cards.create("question", { kind: "question", requestId: "", cancelled: true });
        void parked(new AbortController().signal);
        const gate = Promise.withResolvers<void>();
        const turns: AgentTurn[] = [];
        const askThenFinish = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            turns.push(input);
            yield questionFrame(requestId);
            await gate.promise;
            yield { kind: "resolved", requestId };
            yield { kind: "done" };
        };
        const services = spawnServices({}, [], actors);
        const result = await spawnChild(drivenBy(services, askThenFinish), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        const stranger = { conversationId: "conv-other", cwd: "/work" };

        // The real parent can see the card, so the refusals below are about who's asking, not state.
        expect(pendingQuestionOf(actors, result.id)).toMatchObject({ kind: "question", requestId });

        await expect(answerChild(services, stranger, result.id, { "Which port should the server bind?": ["8080"] })).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("No such child"),
        });
        await expect(sendToChild(drivenBy(services, askThenFinish), stranger, result.id, "do something else")).resolves.toMatchObject({
            ok: false,
            message: expect.stringContaining("No such child"),
        });
        await expect(mergeChild(services, stranger, result.id)).resolves.toEqual({
            ok: false,
            message: "No such child of this conversation. `list` shows yours.",
        });
        // The stranger's send started no turn; the child is still parked, unanswered.
        expect(turns).toHaveLength(1);
        expect(pendingQuestionOf(actors, result.id)).toMatchObject({ kind: "question", requestId });

        gate.resolve();
        await settled(result.id);
    });

    // `list` shows both kinds alike, so an id naming a subagent this conversation's own runtime ran in-process is told
    // what it is, rather than that it names nothing: it lives in the turn that started it, which no service call reaches.
    it("tells an id naming an in-process subagent of this conversation apart from one naming nothing", async () => {
        noteSubagentTask(
            { conversationId: parent.conversationId, conversations: actors, subagentsDir: undefined },
            { subtype: "task_started", task_id: "task-in", tool_use_id: "call-in", subagent_type: "Explore" },
        );
        const services = spawnServices({}, [], actors);
        const inProcess = { ok: false, message: expect.stringContaining("ran in-process, inside this conversation's own turn") };
        await expect(sendToChild(services, parent, "call-in", "more")).resolves.toEqual(inProcess);
        await expect(answerChild(services, parent, "call-in", { anything: ["yes"] })).resolves.toEqual(inProcess);
        await expect(cancelChild(services, parent, "call-in")).resolves.toEqual(inProcess);
        // Its edits are already in this conversation's tree: there is nothing of it to merge.
        await expect(mergeChild(services, parent, "call-in")).resolves.toEqual(inProcess);
        // Another conversation's in-process subagent is nothing of this one's.
        await expect(sendToChild(services, { conversationId: "conv-other", cwd: "/work" }, "call-in", "more")).resolves.toEqual({
            ok: false,
            message: "No such child of this conversation. `list` shows yours.",
        });
    });

    it("send to a settled child runs a follow-up turn on its own conversation, continuing its session", async () => {
        const turns: AgentTurn[] = [];
        const withSession = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            turns.push(input);
            yield { kind: "session", sessionId: "sess-child-1" };
            yield { kind: "delta", text: "first pass done" };
            yield { kind: "text_end" };
            yield { kind: "done" };
        };
        const services = spawnServices({}, [], actors);
        const result = await spawnChild(drivenBy(services, withSession), parent, { prompt: "port it", provider: "cursor", model: "composer-2.5" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        const sent = await sendToChild(drivenBy(services, withSession), parent, result.id, "also handle nested arrays");
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
        expect(listSubagentSessions(actors)[0]).toMatchObject({ id: result.id, status: "completed", summary: "first pass done" });
    });

    it("send to a working child on a runtime with no steering seam refuses honestly", async () => {
        const gate = Promise.withResolvers<void>();
        const holdOpen = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            void input;
            await gate.promise;
            yield { kind: "done" };
        };
        const services = spawnServices({}, [], actors);
        const result = await spawnChild(drivenBy(services, holdOpen), parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        const sent = await sendToChild(drivenBy(services, holdOpen), parent, result.id, "more");
        expect(sent).toMatchObject({ ok: false, message: expect.stringContaining("mid-turn") });
        gate.resolve();
        await settled(result.id);
    });
});

// A child's conversation is not only its parent's: the owner can write in its chat, send it a land conflict, or the land
// check can send a failure back to it. A follow-up that meets one of those turns must still arrive, and say where it is.
describe("a follow-up that meets a turn somebody else started", () => {
    // Polls the roster until the child reads `status`, so an assertion never races the detached start.
    const rowReading = async (id: string, status: string): Promise<SubagentSession | undefined> => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
            const row = listSubagentSessions(actors).find((session) => session.id === id);
            if (row?.status === status) {
                return row;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return listSubagentSessions(actors).find((session) => session.id === id);
    };

    it("waits for that turn to end and then runs, named by the child's task, instead of being dropped", async () => {
        const turns: AgentTurn[] = [];
        const conflictResolved = Promise.withResolvers<void>();
        // Every turn ends at once but the owner's, which holds until the test lets it go.
        const body = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            turns.push(input);
            if (input.prompt === "Resolve the land conflict") {
                await conflictResolved.promise;
            }
            yield { kind: "done" };
        };
        const services = drivenBy(spawnServices({}, [], actors), body);
        const result = await spawnChild(services, parent, {
            prompt: "port it",
            description: "Port the parser",
            provider: "cursor",
            model: "composer-2.5",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(services.turns.run({ conversationId: result.id, prompt: "Resolve the land conflict" })).not.toBe("busy");

        const sent = await sendToChild(services, parent, result.id, "Now the lexer too.");

        expect(sent).toEqual({
            ok: true,
            note: "Sent, to run next: it is busy with a turn it did not get from you (a person, a land conflict or a failing check sent back to it), and your message runs as its own follow-up once that ends. Supervise it with wait.",
        });
        expect(await rowReading(result.id, "pending")).toMatchObject({
            status: "pending",
            summary: "Waiting for the turn already running on it to end; your message runs right after.",
            description: "Port the parser",
        });
        // One message waits at a time: a second is refused, saying why, rather than steered into the owner's turn.
        expect(await sendToChild(services, parent, result.id, "And the docs.")).toEqual({
            ok: false,
            message: "Your last message is still waiting for the turn already running on it to end: wait for it, then send again.",
        });
        conflictResolved.resolve();
        await settled(result.id);
        expect(turns.map((turn) => turn.prompt)).toEqual(["port it", "Resolve the land conflict", "Now the lexer too."]);
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)).toMatchObject({
            status: "completed",
            description: "Port the parser",
        });
    });

    // The room a turn is admitted with is held only briefly, so a follow-up that waited behind another turn asks for room
    // again before it starts: otherwise the door would judge it afresh with its run already live, and the child would
    // read as working with nothing running for as long as that second wait lasted.
    it("asks for room again once the turn it waited behind has ended, before its own starts", async () => {
        const conflictResolved = Promise.withResolvers<void>();
        const body = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            if (input.prompt === "Resolve the land conflict") {
                await conflictResolved.promise;
            }
            yield { kind: "done" };
        };
        const driven = drivenBy(spawnServices({}, [], actors), body);
        const admitted: string[] = [];
        const services = unstubbed<Services>("services", {
            ...driven,
            resources: {
                ...driven.resources,
                admit: (request) => {
                    if (request.forTurn === true && request.owner !== undefined) {
                        admitted.push(request.owner);
                    }
                    return driven.resources.admit(request);
                },
            },
        });
        const result = await spawnChild(services, parent, { prompt: "port it", provider: "cursor", model: "composer-2.5" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(services.turns.run({ conversationId: result.id, prompt: "Resolve the land conflict" })).not.toBe("busy");
        await sendToChild(services, parent, result.id, "Now the lexer too.");
        await rowReading(result.id, "pending");
        conflictResolved.resolve();
        await settled(result.id);
        // Its spawn, its follow-up as it was sent, and the follow-up again once the conversation was free.
        expect(admitted).toEqual([result.id, result.id, result.id]);
    });

    it("keeps the row named by the child's task across a follow-up to a settled child", async () => {
        const services = drivenBy(spawnServices({}, [], actors), fakeTurn([]));
        const result = await spawnChild(services, parent, {
            prompt: "port it",
            description: "Port the parser",
            provider: "cursor",
            model: "composer-2.5",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(await sendToChild(services, parent, result.id, "Phase 2 is landed. Rebase onto main first, then the lexer.")).toEqual({
            ok: true,
            note: "Sent: the child runs a follow-up turn, once there is memory for it. Supervise it with wait.",
        });
        await settled(result.id);
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)?.description).toBe("Port the parser");
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
        report: () => undefined,
        landing: () => undefined,
        merge: async () => ({ ok: true }),
        cancel: async () => ({ ok: true }),
        wait: async () => ({ outcome: "unknown-target" }),
    });

    it("answers with exactly the supervisor a qualifying turn recorded", async () => {
        const calls: string[] = [];
        armSupervisor(
            actors,
            "conv-armed",
            supervisor((prompt) => calls.push(prompt)),
        );
        const armed = supervisorFor(actors, "conv-armed");
        await armed?.spawn({ prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        expect(calls).toEqual(["go"]);
    });

    it("has nothing for a conversation no qualifying turn planned", () => {
        expect(supervisorFor(actors, "conv-never-planned")).toBeUndefined();
    });

    it("forgets every arming on reset, the daemon-death story", () => {
        armSupervisor(
            actors,
            "conv-armed",
            supervisor(() => {}),
        );
        resetChildrenForTest(actors);
        expect(supervisorFor(actors, "conv-armed")).toBeUndefined();
    });
});

describe("the budgets, enforced in the daemon", () => {
    it("refuses past the live ceiling, and frees the slot when a child settles", async () => {
        const gate = Promise.withResolvers<void>();
        const holdOpen = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            void input;
            await gate.promise;
            yield { kind: "done" };
        };
        const services = spawnServices({ subagentsAtOnce: 1 }, [], actors);
        const first = await spawnChild(drivenBy(services, holdOpen), parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6" });
        expect(first.ok).toBe(true);
        const second = await spawnChild(drivenBy(services, holdOpen), parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6" });
        expect(second).toMatchObject({ ok: false, message: expect.stringContaining("already running") });
        gate.resolve();
        if (first.ok) {
            await settled(first.id);
        }
        const third = await spawnChild(drivenBy(services, holdOpen), parent, { prompt: "three", provider: "claude", model: "claude-sonnet-4-6" });
        expect(third.ok).toBe(true);
        gate.resolve();
    });

    it("refuses past the lifetime budget", async () => {
        const services = spawnServices({ subagentsPerTurn: 1 }, [], actors);
        const first = await spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6" });
        expect(first.ok).toBe(true);
        if (first.ok) {
            await settled(first.id);
        }
        const second = await spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6" });
        expect(second).toMatchObject({ ok: false, message: expect.stringContaining("lifetime budget") });
    });

    // Guards the race the sequential tests above can't reach: two spawns reading the ledger before either writes it.
    it("holds the live ceiling against spawns that arrive together", async () => {
        const gate = Promise.withResolvers<void>();
        const holdOpen = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            void input;
            await gate.promise;
            yield { kind: "done" };
        };
        const services = spawnServices({ subagentsAtOnce: 1 }, [], actors);

        const results = await Promise.all([
            spawnChild(drivenBy(services, holdOpen), parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6" }),
            spawnChild(drivenBy(services, holdOpen), parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6" }),
            spawnChild(drivenBy(services, holdOpen), parent, { prompt: "three", provider: "claude", model: "claude-sonnet-4-6" }),
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
        const services = spawnServices({ subagentsAtOnce: 1 }, [], actors);
        // Only the prompt explodes: provider and model are read first and gate admission before this path is reached.
        const exploding = {
            description: "a spec that cannot be read",
            provider: "claude",
            model: "claude-sonnet-4-6",
            get prompt(): string {
                throw new Error("boom");
            },
        } as unknown as Parameters<typeof spawnChild>[2];

        await expect(spawnChild(drivenBy(services, fakeTurn([])), parent, exploding)).rejects.toThrow("boom");

        // Proof: the next spawn fits, when a stranded seat under a ceiling of one would refuse it.
        const after = await spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "ok", provider: "claude", model: "claude-sonnet-4-6" });
        expect(after.ok).toBe(true);
    });

    // Targets the lifetime counter: a live seat frees on settle, but N parallel spawns must still cost N against it.
    it("counts every concurrent spawn against the lifetime budget", async () => {
        const services = spawnServices({ subagentsAtOnce: 5, subagentsPerTurn: 2 }, [], actors);

        const results = await Promise.all([
            spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6" }),
            spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6" }),
            spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "three", provider: "claude", model: "claude-sonnet-4-6" }),
            spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "four", provider: "claude", model: "claude-sonnet-4-6" }),
        ]);

        expect(results.filter((result) => result.ok)).toHaveLength(2);
        await Promise.all(results.map(async (result) => (result.ok ? settled(result.id) : undefined)));
        // Proves the concurrent pair was really recorded, not merely let through: a later spawn is refused too.
        const later = await spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "five", provider: "claude", model: "claude-sonnet-4-6" });
        expect(later).toMatchObject({ ok: false, message: expect.stringContaining("lifetime budget") });
    });

    // Keyed by the child's own conversation id, since a child gets the spawn tool too.
    it("refuses a chain deeper than the owner's setting", async () => {
        const services = spawnServices({ subagentDepth: 1 }, [], actors);
        const first = await spawnChild(drivenBy(services, fakeTurn([])), parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6" });
        if (!first.ok) {
            throw new Error(first.message);
        }
        const fromChild = await spawnChild(
            drivenBy(services, fakeTurn([])),
            { conversationId: first.id, cwd: "/work" },
            { prompt: "two", provider: "claude", model: "claude-sonnet-4-6" },
        );
        expect(fromChild).toMatchObject({ ok: false, message: expect.stringContaining("depth") });
        await settled(first.id);
    });
});

describe("placing a child on the fleet", () => {
    // Waits for the child to settle first: reading the turn immediately sees an empty array, so an absent placement
    // would pass on a turn that hadn't started.
    const placementOf = async (services: Services, spec: Parameters<typeof spawnChild>[2]): Promise<AgentTurn["placement"]> => {
        const turns: AgentTurn[] = [];
        const result = await spawnChild(drivenBy(services, fakeTurn(turns)), parent, spec);
        expect(result.ok).toBe(true);
        await settled(result.ok ? result.id : "");
        return turns[0]?.placement;
    };

    // Lets a fan-out of many children spread across connected machines without choosing per agent.
    it("sends a child to a ready runner with no one asking", async () => {
        expect(
            await placementOf(spawnServices({}, [{ id: "rig", online: true }], actors), {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
            }),
        ).toEqual({ kind: "runner", id: "rig" });
    });

    it("keeps the work here when there is no fleet", async () => {
        expect(await placementOf(spawnServices({}, [], actors), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" })).toBeUndefined();
    });

    // Six slots used of eight cores counts as full; the free sandbox wins over waiting.
    it("keeps the work here when every machine is full", async () => {
        expect(
            await placementOf(spawnServices({}, [{ id: "rig", online: true, inFlight: 6 }], actors), {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
            }),
        ).toBeUndefined();
    });

    it("honours a machine the caller named over the one with more room", async () => {
        const fleet = [
            { id: "rig", online: true },
            { id: "other", online: true, cpus: 32 },
        ];
        expect(
            await placementOf(spawnServices({}, fleet, actors), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6", on: "rig" }),
        ).toEqual({
            kind: "runner",
            id: "rig",
        });
        // Nobody asking gets the roomier machine, confirming the line above is a real preference.
        expect(await placementOf(spawnServices({}, fleet, actors), { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" })).toEqual({
            kind: "runner",
            id: "other",
        });
    });

    // Only the Claude Code runtime family's credentials travel (runner-scheduler.credentialsTravel); a Cursor child
    // sent elsewhere dies on its first request, reading as a broken fleet rather than a missing login.
    it("keeps a child here when its runtime authenticates from the machine it runs on", async () => {
        const fleet = [{ id: "rig", online: true }];
        expect(await placementOf(spawnServices({}, fleet, actors), { prompt: "go", model: "claude-sonnet-4-6", provider: "cursor" })).toBeUndefined();
        expect(await placementOf(spawnServices({}, fleet, actors), { prompt: "go", model: "claude-sonnet-4-6", provider: "codex" })).toBeUndefined();
        // The same provider under the claude-code harness routes through the translator, so it does travel.
        expect(
            await placementOf(spawnServices({}, fleet, actors), {
                prompt: "go",
                model: "claude-sonnet-4-6",
                provider: "codex",
                harness: "claude-code",
            }),
        ).toEqual({
            kind: "runner",
            id: "rig",
        });
    });

    it("still honours a machine named for a runtime that authenticates locally: the person knows their fleet", async () => {
        const placed = await placementOf(spawnServices({}, [{ id: "rig", online: true }], actors), {
            prompt: "go",
            model: "claude-sonnet-4-6",
            provider: "cursor",
            on: "rig",
        });
        expect(placed).toEqual({ kind: "runner", id: "rig" });
    });

    it("`here` pins a child to this sandbox even with a fleet standing by", async () => {
        expect(
            await placementOf(spawnServices({}, [{ id: "rig", online: true }], actors), {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
                on: "here",
            }),
        ).toBeUndefined();
    });
});

// Same floor fires either way; what differs is whether a live turn exists to draw a card on. Every other test here has
// none, which is the detached `agents` shell case and is still the correct refusal. Nothing waits on the card: the move
// comes back at once, held, and what the owner answers decides it later.
describe("a held supervisor call asks the owner where there is one to ask", () => {
    // Keeps a parent turn open for the test via the real pump, not a stand-in, so `turnRunOf` finds a live stream a
    // card can actually be raised into.
    const liveParent = (): { release: () => void } => {
        let release = (): void => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        // eslint-disable-next-line require-yield
        const forever: TurnStarter["stream"] = async function* pump() {
            await held;
        };
        startTurnRun({ conversations: actors, events: createDomainEvents(() => {}) }, forever, {
            conversationId: parent.conversationId,
            prompt: "parent",
        });
        return { release };
    };

    // The newest card on the parent's own frame log that has not settled, exactly what a client would answer.
    const cardOn = async (): Promise<string> => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const card = turnRunOf(actors, parent.conversationId)
                ?.rows.map((row) => row.permission)
                .findLast((permission) => permission !== undefined && permission.status === "pending");
            if (card !== undefined) {
                return card.requestId;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error("no permission card was raised on the parent's turn");
    };
    const cardOf = (requestId: string) =>
        turnRunOf(actors, parent.conversationId)
            ?.rows.map((row) => row.permission)
            .find((permission) => permission?.requestId === requestId);

    // What the sandbox said into the parent's turn, as a parent mid-turn hears it.
    let told: string[] = [];
    beforeEach(() => {
        told = [];
    });
    // The owner's rules and the stream a child runs on, with the parent mid-turn: the parent reads as running and has a
    // record, and what is said into its turn is kept above.
    const heldServices = (rules: Record<string, "allow" | "hold" | "deny">, stream: TurnStarter["stream"]): Services => {
        const driven = drivenBy(spawnServices({ actionRules: rules }, [], actors), stream);
        return unstubbed<Services>("services", {
            ...driven,
            conversations: { ...driven.conversations, running: (id: string) => id === parent.conversationId || driven.conversations.running(id) },
            agents: unstubbed<Services["agents"]>("agents", {
                entry: (id: string) => (id === parent.conversationId ? conversationEntry({ id }) : undefined),
            }),
            turns: {
                ...driven.turns,
                say: async (said) => {
                    told.push(said.turn.prompt);
                    return { delivered: "steered", run: "run-parent" };
                },
            },
        });
    };
    const HOLD = { "agents.spawn": "hold" } as const;

    // Polls until `ready` holds, so an assertion never races a detached start.
    const until = async (ready: () => boolean): Promise<void> => {
        for (let attempt = 0; attempt < 400 && !ready(); attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };

    it("comes back at once with the child waiting on the owner, and starts it once they allow it", async () => {
        const live = liveParent();
        try {
            const turns: AgentTurn[] = [];
            const result = await spawnChild(heldServices(HOLD, fakeTurn(turns)), parent, {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
            });
            if (!result.ok) {
                throw new Error(result.message);
            }
            expect(result).toEqual({
                ok: true,
                id: result.id,
                held: true,
                // Says why the owner is asked and how long the card waits, so the parent can tell a rule from a taint and
                // knows it may ask again.
                note: "Held for the owner's approval, because spawning subagents on claude requires owner approval. A card in your chat asks them, and you carry on meanwhile. The card lasts while your turn does (at most 6 hours): if nobody answers by then the move does not happen, nothing is declined, and you may ask again. It starts once they allow it; wait on it like any child, which also keeps your turn, and the card, open. If they decline, or nobody answers in time, it ends as failed without having run.",
            });
            // Filed as a child already, so the parent's wait parks on it like any other.
            expect(listSubagentSessions(actors).find((session) => session.id === result.id)).toMatchObject({
                status: "pending",
                summary: "Waiting for the owner to allow its start, on the card in your chat.",
            });
            expect(turns).toEqual([]);
            const requestId = await cardOn();
            // Names the move and provider, so answering it isn't a guess about what it does; offers the turn-long allow.
            expect(cardOf(requestId)).toMatchObject({
                toolName: "agents.spawn",
                title: "Start a subagent on Claude Code?",
                displayName: "Start it",
                alwaysLabel: "Allow for the rest of this turn",
            });
            expect(cards.resolve({ kind: "permission", requestId, decision: "once" })).toBe("settled");
            await settled(result.id);
            expect(turns.map((turn) => turn.conversationId)).toEqual([result.id]);
            // Settles on the parent's run, so a client stops drawing the card as live.
            expect(cardOf(requestId)?.status).toBe("allowed");
            // Nothing the parent could not see for itself: its wait shows the start.
            expect(told).toEqual([]);
        } finally {
            live.release();
        }
    });

    // The turn the owner lets start is the one that opens the child's conversation, so it opens it as an unheld start
    // would: named by the parent's words, and answering a spent allowance itself under a sandbox that waits for a press.
    it("a start nobody answers before the parent's turn ends says why it was held, and that it may be asked again", async () => {
        const live = liveParent();
        const turns: AgentTurn[] = [];
        const result = await spawnChild(heldServices(HOLD, fakeTurn(turns)), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await cardOn();
        live.release();
        const ended = await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["finished"], timeoutMs: 5_000 });
        expect(ended).toMatchObject({
            outcome: "finished",
            matched: {
                status: "failed",
                error: "Nobody answered the owner's card to start this subagent before your turn ended, so it did not run. It was held because spawning subagents on claude requires owner approval. Nothing was declined: you may ask again, which raises a new card, and waiting on it keeps your turn (and so the card) open. If the work cannot wait for the owner, say what you left undone.",
            },
        });
        expect(turns).toEqual([]);
    });

    it("a start the owner allows opens the child's conversation as a start nobody held would", async () => {
        const live = liveParent();
        try {
            const turns: TurnInput[] = [];
            const result = await spawnChild(heldServices(HOLD, fakeTurn(turns)), parent, {
                prompt: "go",
                description: "Port the parser",
                provider: "claude",
                model: "claude-sonnet-4-6",
            });
            if (!result.ok) {
                throw new Error(result.message);
            }
            cards.resolve({ kind: "permission", requestId: await cardOn(), decision: "once" });
            await settled(result.id);
            expect(turns[0]).toMatchObject({ title: "Port the parser", titleSource: "model", postures: { limit: "resend" } });
        } finally {
            live.release();
        }
    });

    it("a denial ends the waiting child as failed, never run, and tells the model not to retry", async () => {
        const live = liveParent();
        try {
            const turns: AgentTurn[] = [];
            const services = heldServices(HOLD, fakeTurn(turns));
            const result = await spawnChild(services, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
            if (!result.ok) {
                throw new Error(result.message);
            }
            cards.resolve({ kind: "permission", requestId: await cardOn(), decision: "deny" });
            const ended = await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["finished"], timeoutMs: 5_000 });
            expect(ended.matched).toMatchObject({
                status: "failed",
                error: "The owner declined this. Do not retry: carry on with what you can do without it, and say plainly what you left undone.",
            });
            expect(turns).toEqual([]);
            // Its wait took the ending, so nothing is said twice; and nothing can be sent under an id that never ran.
            expect(told).toEqual([]);
            expect(await sendToChild(services, parent, result.id, "more")).toMatchObject({
                ok: false,
                message: expect.stringContaining("No such child"),
            });
        } finally {
            live.release();
        }
    });

    it("a parent not waiting when the owner declines hears it in its turn, once", async () => {
        const live = liveParent();
        try {
            const result = await spawnChild(heldServices(HOLD, fakeTurn([])), parent, {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
            });
            if (!result.ok) {
                throw new Error(result.message);
            }
            cards.resolve({ kind: "permission", requestId: await cardOn(), decision: "deny" });
            await until(() => told.length > 0);
            expect(told).toEqual([
                `Your subagent \`${result.id}\` did not start: The owner declined this. Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
            ]);
            // Said into its turn, so its next wait does not hand the same ending over again.
            expect(await waitForSubagent(actors, parent.conversationId, { until: ["finished"], timeoutMs: 1_000 })).toMatchObject({
                outcome: "unknown-target",
            });
        } finally {
            live.release();
        }
    });

    // What the owner is asked to allow is on the card itself, from the call, not the agent's prose about it.
    it("shows the child it would start: task, model, effort, account and machine", async () => {
        const live = liveParent();
        try {
            const result = await spawnChild(heldServices(HOLD, fakeTurn([])), parent, {
                prompt: "Port the parser to zig",
                description: "Port the parser",
                provider: "claude",
                model: "claude-opus-4-6",
                effort: "max",
                account: "work",
                on: "here",
            });
            const requestId = await cardOn();
            expect(cardOf(requestId)?.child).toEqual({
                move: "spawn",
                task: "Port the parser",
                provider: "claude",
                model: "claude-opus-4-6",
                effort: "max",
                account: "work",
                on: "here",
            });
            cards.resolve({ kind: "permission", requestId, decision: "deny" });
            if (result.ok) {
                await settled(result.id);
            }
        } finally {
            live.release();
        }
    });

    // The owner's pick replaces the agent's whole: an effort or an account named for one model means nothing on another.
    it("starts the child on what the owner picked on the card, and tells the parent so", async () => {
        const live = liveParent();
        try {
            const turns: AgentTurn[] = [];
            const result = await spawnChild(heldServices(HOLD, fakeTurn(turns)), parent, {
                prompt: "go",
                provider: "claude",
                model: "claude-opus-4-6",
                effort: "max",
                account: "work",
            });
            if (!result.ok) {
                throw new Error(result.message);
            }
            const requestId = await cardOn();
            cards.resolve({ kind: "permission", requestId, decision: "once", child: { provider: "claude", model: "claude-haiku-4-5", fast: true } });
            await settled(result.id);
            expect(turns[0]).toMatchObject({ agent: "claude", model: "claude-haiku-4-5", fast: true });
            expect(turns[0]).not.toHaveProperty("effort");
            expect(turns[0]).not.toHaveProperty("account");
            expect(listSubagentSessions(actors).find((session) => session.id === result.id)?.model).toBe("claude-haiku-4-5");
            await until(() => told.length > 0);
            expect(told).toEqual([
                `The owner allowed your subagent \`${result.id}\` to start. The owner changed what it runs on before allowing it: it runs on claude/claude-haiku-4-5, fast speed, not on claude/claude-opus-4-6, max effort, account work as you asked.`,
            ]);
            // The settled card reads what started, keeping what the agent asked for beside it.
            expect(cardOf(requestId)?.child).toMatchObject({ model: "claude-haiku-4-5", proposed: { model: "claude-opus-4-6", effort: "max" } });
        } finally {
            live.release();
        }
    });

    it("an allow that picks what the agent asked for anyway changes nothing and says nothing", async () => {
        const live = liveParent();
        try {
            const turns: AgentTurn[] = [];
            const result = await spawnChild(heldServices(HOLD, fakeTurn(turns)), parent, {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
            });
            if (!result.ok) {
                throw new Error(result.message);
            }
            cards.resolve({
                kind: "permission",
                requestId: await cardOn(),
                decision: "once",
                child: { provider: "claude", model: "claude-sonnet-4-6", harness: "native" },
            });
            await settled(result.id);
            expect(turns).toHaveLength(1);
            expect(told).toEqual([]);
        } finally {
            live.release();
        }
    });

    // The card overrides the agent's choice, never the owner's own rulebook.
    it("a provider the rules refuse stays refused when it is picked on the card", async () => {
        const live = liveParent();
        try {
            const turns: AgentTurn[] = [];
            const result = await spawnChild(heldServices({ "agents.spawn": "hold", "agents.spawn.cursor": "deny" }, fakeTurn(turns)), parent, {
                prompt: "go",
                provider: "claude",
                model: "claude-sonnet-4-6",
            });
            if (!result.ok) {
                throw new Error(result.message);
            }
            cards.resolve({ kind: "permission", requestId: await cardOn(), decision: "once", child: { provider: "cursor", model: "composer-2.5" } });
            const ended = await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["finished"], timeoutMs: 5_000 });
            expect(ended.matched).toMatchObject({ status: "failed", error: expect.stringContaining("refused by the action rules") });
            expect(turns).toEqual([]);
        } finally {
            live.release();
        }
    });

    // "For the rest of this turn" is one provider's, and one turn's: the next turn, or another provider, asks again.
    it("the owner's turn-long allow lets later moves on that provider through, and lapses with the turn", async () => {
        const turns: AgentTurn[] = [];
        const first = liveParent();
        try {
            const services = heldServices(HOLD, fakeTurn(turns));
            const asked = await spawnChild(services, parent, { prompt: "one", provider: "claude", model: "claude-sonnet-4-6" });
            const requestId = await cardOn();
            cards.resolve({ kind: "permission", requestId, decision: "always" });
            if (asked.ok) {
                await settled(asked.id);
            }
            expect(cardOf(requestId)?.status).toBe("always");
            const again = await spawnChild(services, parent, { prompt: "two", provider: "claude", model: "claude-sonnet-4-6" });
            expect(again).toEqual({ ok: true, id: again.ok ? again.id : "" });
            if (again.ok) {
                await settled(again.id);
            }
            const other = await spawnChild(services, parent, { prompt: "three", provider: "cursor", model: "composer-2.5" });
            expect(other).toMatchObject({ ok: true, held: true });
            cards.resolve({ kind: "permission", requestId: await cardOn(), decision: "deny" });
        } finally {
            first.release();
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        const second = liveParent();
        try {
            const next = await spawnChild(heldServices(HOLD, fakeTurn(turns)), parent, {
                prompt: "four",
                provider: "claude",
                model: "claude-sonnet-4-6",
            });
            expect(next).toMatchObject({ ok: true, held: true });
            cards.resolve({ kind: "permission", requestId: await cardOn(), decision: "deny" });
        } finally {
            second.release();
        }
        expect(turns.map((turn) => turn.prompt)).toEqual(["one", "two"]);
    });

    // A child already running keeps the run it was started on: a send's card shows it, and an allow cannot move it.
    it("a send's card names the child, its run and the words; the message goes once allowed, keeping its run", async () => {
        const turns: AgentTurn[] = [];
        const first = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn(turns)), parent, {
            prompt: "Port the parser",
            provider: "claude",
            model: "claude-sonnet-4-6",
            effort: "high",
        });
        if (!first.ok) {
            throw new Error(first.message);
        }
        await settled(first.id);
        const live = liveParent();
        try {
            const services = heldServices(HOLD, fakeTurn(turns));
            expect(await sendToChild(services, parent, first.id, "Now the lexer too.")).toEqual({
                ok: true,
                note: "Held for the owner's approval, because spawning subagents on claude requires owner approval. A card in your chat asks them, and you carry on meanwhile. The card lasts while your turn does (at most 6 hours): if nobody answers by then the move does not happen, nothing is declined, and you may ask again. It goes to the child once they allow it, and you are told if it does not.",
            });
            // One message waits on the owner at a time.
            expect(await sendToChild(services, parent, first.id, "And the docs.")).toEqual({
                ok: false,
                message: "Your last message to it still waits for the owner's approval: wait for that, then send again.",
            });
            const requestId = await cardOn();
            expect(cardOf(requestId)?.title).toBe("Send this to a subagent on Claude Code?");
            expect(cardOf(requestId)?.child).toMatchObject({
                move: "send",
                child: first.id,
                task: "Port the parser",
                message: "Now the lexer too.",
                provider: "claude",
                model: "claude-sonnet-4-6",
                effort: "high",
            });
            cards.resolve({ kind: "permission", requestId, decision: "once", child: { provider: "cursor", model: "composer-2.5" } });
            await until(() => turns.length === 2);
            await settled(first.id);
            expect(turns[1]).toMatchObject({ prompt: "Now the lexer too.", agent: "claude", model: "claude-sonnet-4-6", effort: "high" });
        } finally {
            live.release();
        }
    });

    it("a declined message is told to the parent, and the child hears nothing", async () => {
        const turns: AgentTurn[] = [];
        const first = await spawnChild(drivenBy(spawnServices({}, [], actors), fakeTurn(turns)), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!first.ok) {
            throw new Error(first.message);
        }
        await settled(first.id);
        const live = liveParent();
        try {
            await sendToChild(heldServices(HOLD, fakeTurn(turns)), parent, first.id, "Now the lexer too.");
            cards.resolve({ kind: "permission", requestId: await cardOn(), decision: "deny" });
            await until(() => told.length > 0);
            expect(told).toEqual([
                `Your message to subagent \`${first.id}\` did not go: The owner declined this. Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
            ]);
            expect(turns).toHaveLength(1);
        } finally {
            live.release();
        }
    });

    // With no live turn to draw a card on (a backgrounded shell, an ended turn), it still refuses and names which case
    // it is.
    it("with no live turn there is nowhere to ask, and it says so", async () => {
        const held = await spawnChild(drivenBy(spawnServices({ actionRules: HOLD }, [], actors), fakeTurn([])), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        const message = held.ok === false ? held.message : "";
        expect(message).toContain("outside a live turn");
        expect(message).toContain("agents.spawn");
    });
});

// A turn that starts on a child without its parent (the sandbox's own re-run, a watch it left, another conversation's
// message) is still the parent's to supervise; a person's own turn in the child's chat stays theirs.
describe("a turn the child did not get from its parent", () => {
    const told: string[] = [];
    beforeEach(() => {
        told.length = 0;
    });
    const parentHears = (stream: TurnStarter["stream"]): Services => {
        const driven = drivenBy(spawnServices({}, [], actors), stream);
        return unstubbed<Services>("services", {
            ...driven,
            conversations: { ...driven.conversations, running: (id: string) => id === parent.conversationId || driven.conversations.running(id) },
            agents: unstubbed<Services["agents"]>("agents", {
                entry: (id: string) => (id === parent.conversationId ? conversationEntry({ id }) : undefined),
            }),
            turns: {
                ...driven.turns,
                say: async (said) => {
                    told.push(said.turn.prompt);
                    return { delivered: "steered", run: "run-parent" };
                },
            },
        });
    };

    it("a re-run the sandbox fires by itself reopens the child's row, reports its ending, and tells the parent it is working", async () => {
        const gate = Promise.withResolvers<void>();
        const body = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            if (input.prompt === "Port the parser (sent again)") {
                await gate.promise;
                yield { kind: "delta", text: "Ported, on the second try." };
                yield { kind: "text_end" };
            }
            yield { kind: "done" };
        };
        const services = parentHears(body);
        const result = await spawnChild(services, parent, {
            prompt: "Port the parser",
            description: "Port the parser",
            provider: "cursor",
            model: "composer-2.5",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(services.turns.run({ conversationId: result.id, prompt: "Port the parser (sent again)" })).not.toBe("busy");

        adoptChildTurn(services, { conversationId: result.id, speaker: { kind: "sandbox" }, resume: "limit", errand: undefined });

        expect(listSubagentSessions(actors).find((session) => session.id === result.id)).toMatchObject({
            status: "running",
            description: "Port the parser",
        });
        expect(told).toEqual([
            `Your subagent \`${result.id}\` ("Port the parser") is working: the sandbox sent its turn again by itself because its allowance reopened. Its report reaches you when it ends, like any turn of its: do not send it the task again or give the task to another agent meanwhile.`,
        ]);
        // It is the child's live turn now, as far as its parent can reach it: words steer into it, not a second turn.
        expect(await sendToChild(services, parent, result.id, "also the lexer")).toMatchObject({
            ok: false,
            message: expect.stringContaining("mid-turn"),
        });
        gate.resolve();
        expect(await waitForSubagent(actors, parent.conversationId, { until: ["finished"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "finished",
            matched: { id: result.id, status: "completed", summary: "Ported, on the second try." },
        });
    });

    it("leaves a person's own turn in the child's chat to them", async () => {
        const gate = Promise.withResolvers<void>();
        const body = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            if (input.prompt === "Let me look at this myself") {
                await gate.promise;
            }
            yield { kind: "done" };
        };
        const services = parentHears(body);
        const result = await spawnChild(services, parent, { prompt: "go", provider: "cursor", model: "composer-2.5" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        services.turns.run({ conversationId: result.id, prompt: "Let me look at this myself" });

        adoptChildTurn(services, {
            conversationId: result.id,
            speaker: { kind: "person", email: "owner@example.com" },
            resume: undefined,
            errand: undefined,
        });

        expect(listSubagentSessions(actors).find((session) => session.id === result.id)?.status).toBe("completed");
        expect(told).toEqual([]);
        gate.resolve();
    });

    it("says with a failure that the sandbox runs the same turn again by itself, and when", async () => {
        const body = async function* (): AsyncGenerator<AgentEvent> {
            yield { kind: "error", message: "You've hit your usage limit.", autoResume: "scheduled", nextAt: Date.UTC(2026, 8, 26, 15, 38) / 1000 };
            yield { kind: "done" };
        };
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), body), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        // Paused, not finished: the parent's wait for an ending keeps covering it, and a wait for a move hands it over.
        const paused = await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        expect(paused).toMatchObject({
            outcome: "blocked",
            matched: {
                status: "paused",
                error: `You've hit your usage limit. The sandbox runs this same turn again by itself at 15:38 UTC, and its report reaches you when that ends: do not send it the task again or give the task to another agent meanwhile. To have it not run again, cancel it (the cancel tool, or \`agents cancel ${result.id}\`), then decide yourself.`,
            },
        });
        const stillWaiting = await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["finished"], timeoutMs: 20 });
        expect(stillWaiting.outcome).toBe("timeout");
    });

    it("the sandbox's re-run takes over a paused row, and its ending is the one the parent's wait gets", async () => {
        const gate = Promise.withResolvers<void>();
        const body = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            if (input.prompt === "go (sent again)") {
                await gate.promise;
                yield { kind: "delta", text: "Done on the re-run." };
                yield { kind: "text_end" };
            } else {
                yield { kind: "error", message: "You're out of usage.", autoResume: "scheduled" };
            }
            yield { kind: "done" };
        };
        const services = parentHears(body);
        const result = await spawnChild(services, parent, {
            prompt: "go",
            description: "Port the parser",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        expect(await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "blocked",
            matched: { status: "paused" },
        });
        expect(services.turns.run({ conversationId: result.id, prompt: "go (sent again)" })).not.toBe("busy");
        adoptChildTurn(services, { conversationId: result.id, speaker: { kind: "sandbox" }, resume: "stopped", errand: undefined });
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)).toMatchObject({
            status: "running",
            description: "Port the parser",
        });
        gate.resolve();
        expect(await settled(result.id)).toMatchObject({ outcome: "finished", matched: { status: "completed", summary: "Done on the re-run." } });
    });

    it("a message to a paused child is the turn it waits on from then, taking over the row", async () => {
        const turns: AgentTurn[] = [];
        const body = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            turns.push(input);
            if (input.prompt === "go") {
                yield { kind: "error", message: "You're out of usage.", autoResume: "scheduled" };
            }
            yield { kind: "done" };
        };
        const services = drivenBy(spawnServices({}, [], actors), body);
        const result = await spawnChild(services, parent, {
            prompt: "go",
            description: "Port the parser",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(actors, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        expect(await sendToChild(services, parent, result.id, "Carry on on another account.")).toMatchObject({ ok: true });
        expect(await settled(result.id)).toMatchObject({ outcome: "finished", matched: { status: "completed", description: "Port the parser" } });
        expect(turns.map((turn) => turn.prompt)).toEqual(["go", "Carry on on another account."]);
    });
});

// From the spawn to the parent's news, over the real registry and the daemon's own classification of the refusal. Fifteen
// children once sat in the owner's Attention lane after a spent allowance, each waiting for a press, while their parent
// armed a watch of its own to resume them: a child's own answer books the re-run at the reset instead.
describe("a child whose allowance runs out", () => {
    const RESETS_AT = Date.UTC(2026, 8, 26, 15, 38) / 1000;
    const BOOKED =
        "The sandbox runs this same turn again by itself at 15:38 UTC, and its report reaches you when that ends: do not send it the task again or give the task to another agent meanwhile.";

    // The provider's refusal with a known reset, classified as the daemon's turn classifies it (stream-agent.ts), asking
    // the conversation's own answer to the ending where the daemon asks it; the rest is a turn that ran and left nothing.
    const refusedAsked = (answers: Pick<Services, "agents" | "sandboxSettings">, conversations: Fleet["conversations"]) =>
        async function* refused(input: RoutedTurn): AsyncGenerator<AgentEvent> {
            const { frame, held } = await classifyFailure(
                { kind: "error", code: "rate_limit", message: "You've hit your usage limit.", resetsAt: RESETS_AT },
                {
                    turn: input,
                    turnId: "t-1",
                    provider: input.agent,
                    model: input.model,
                    account: undefined,
                    attribution: {},
                    sessionId: undefined,
                    answered: true,
                    remint: undefined,
                    limitReset: undefined,
                    outage: undefined,
                    standing: { state: "no-code", paths: [], check: undefined },
                    checklist: undefined,
                    contextTokens: undefined,
                    now: Date.now(),
                },
                {
                    breakPolicy: (conversationId, ending) => breakPolicyFor(answers, conversationId, ending),
                    reopensAt: async () => undefined,
                    limitWay: async () => undefined,
                    stopLadder: () => ({ made: 0, nextAt: undefined }),
                    awaitingVerification: async () => [],
                },
            );
            // The hold a real turn's exit records ahead of its settle (settle-turn.ts recordResumes), which the resume
            // pass fires and the card's booking reads.
            if (held !== undefined) {
                conversations.send(held.input.conversationId, { kind: "turn-held", held });
            }
            yield frame;
            yield { kind: "done" };
        };

    // A sandbox whose standing answer waits for a person's press, as it does by default, over a real fleet.
    const refusingFleet = async () => {
        const fleet = memoryFleet();
        await fleet.agents.init();
        const base = spawnServices({ limitPolicy: "wait" }, [], fleet.conversations);
        const services = drivenBy(
            unstubbed<Services>("services", { ...base, agents: fleet.agents }),
            conversationTurn(fleet, refusedAsked({ agents: fleet.agents, sandboxSettings: base.sandboxSettings }, fleet.conversations)),
        );
        return { fleet, services };
    };

    it("books its own re-run at the reset, and its parent hears it is coming from its report and its wait", async () => {
        const { fleet, services } = await refusingFleet();
        // The parent is a conversation on the same fleet, which its child's report is delivered to.
        await beginTurn(
            fleet.conversations,
            { conversationId: parent.conversationId, isolated: false, prompt: "Audit the tests", profile: {} },
            1_000,
        );
        await fleet.conversations.send(parent.conversationId, { kind: "settle" }, 2_000).settled;
        const ended = new Promise<DomainEventMap["run.settled"]>((resolve) => services.events.subscribe("run.settled", resolve));

        const result = await spawnChild(services, parent, {
            prompt: "Review the audit of batch 24",
            description: "Test audit reviewer, batch 24",
            provider: "codex",
            model: "gpt-5.1-codex",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        const settledRun = await ended;

        // Booked at the reset, which is what keeps the card out of the Attention lane.
        expect(fleet.agents.get(result.id)).toMatchObject({
            title: "Test audit reviewer, batch 24",
            limitPolicy: "resend",
            failureCode: "rate_limit",
            limitResetsAt: RESETS_AT,
            limitHeld: true,
            limitScheduled: true,
        });
        expect(settledRun.rerun).toEqual({ at: RESETS_AT });

        // Delivered as boot-schedulers.ts wires the report, before any wait of the parent's takes the ending.
        const parentTurns = fakeTurns();
        await reportChildTurn(
            {
                doors: { turns: parentTurns.turns, sessionIdOf: () => undefined },
                logger: services.logger,
                conversations: fleet.conversations,
                entryOf: (conversationId) => {
                    const entry = fleet.agents.entry(conversationId);
                    return entry === undefined ? undefined : { startedBy: entry.identity.startedBy, title: entry.social.title?.text };
                },
                profileOf: (conversationId) => {
                    const entry = fleet.agents.entry(conversationId);
                    return entry === undefined ? undefined : conversationProfile(entry);
                },
                killNote: async () => undefined,
                landingOf: (childId) => childLandingWords(fleet.agents, childId),
            },
            settledRun,
        );
        const report = parentTurns.started[0]?.prompt ?? "";
        expect(agentWordsOf(report)).toMatchObject({ kind: "child", from: result.id, title: "Test audit reviewer, batch 24", failed: true });
        const cancelWords = ` To have it not run again, cancel it (the cancel tool, or \`agents cancel ${result.id}\`), then decide yourself.`;
        // The re-run leads, ahead of the failure, so the parent reads it before it reads that the turn failed.
        expect(report).toContain(`Paused, not finished. ${BOOKED}${cancelWords}\n\nThe turn failed: You've hit your usage limit.`);
        const moved = await waitForSubagent(fleet.conversations, parent.conversationId, {
            target: result.id,
            until: ["blocked", "finished"],
            timeoutMs: 5_000,
        });
        expect(moved).toMatchObject({
            outcome: "blocked",
            matched: { status: "paused", error: `You've hit your usage limit. ${BOOKED}${cancelWords}` },
        });
    });

    // The duplicate this prevents: a parent that gives the task to another agent cancels the original first, so the
    // re-run booked at the reset never redoes it.
    it("a parent's cancel drops the booked re-run, so the child never runs the task a second time", async () => {
        const { fleet, services } = await refusingFleet();
        const result = await spawnChild(services, parent, { prompt: "Review the audit", provider: "codex", model: "gpt-5.1-codex" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await waitForSubagent(fleet.conversations, parent.conversationId, { target: result.id, until: ["blocked"], timeoutMs: 5_000 });
        // The hold the resume pass would fire at the reset, as the daemon records it for a refused turn.
        await fleet.conversations.send(result.id, {
            kind: "turn-held",
            held: { input: { conversationId: result.id, prompt: "Review the audit" }, reason: "limit", ran: true, reopensAt: RESETS_AT },
        }).settled;
        expect(fleet.conversations.state(result.id)?.resume.held).toMatchObject({ reason: "limit", fired: false });

        expect(await cancelChild(services, parent, result.id)).toEqual({
            ok: true,
            note: "Cancelled: the sandbox will not run it again by itself, and it ends as killed. Send it a message to carry on from where it stopped.",
        });
        expect(fleet.conversations.state(result.id)?.resume.held).toBeUndefined();
        // Nor does its card go on saying a re-run is booked, which would hold it, and its parent's card, in Active.
        expect(fleet.agents.get(result.id)?.limitScheduled).toBeUndefined();
        expect((await finishedIn(fleet, result.id)).matched).toMatchObject({
            status: "killed",
            error: "You've hit your usage limit. Stopped: its parent cancelled it.",
        });
        // Nothing is left to cancel, and it says so rather than pretending.
        expect(await cancelChild(services, parent, result.id)).toEqual({
            ok: false,
            message: "It is not running, and nothing is booked to run it again: there is nothing to cancel.",
        });
    });

    // Only a spawned child answers for itself: the same refusal on a conversation a person opened keeps the sandbox's
    // answer, and is only offered to its reader.
    it("leaves a conversation nobody spawned to the sandbox's answer, which waits for a press", async () => {
        const { fleet, services } = await refusingFleet();
        const run = services.turns.run({ conversationId: "top-1", prompt: "Review the audit of batch 24", agent: "codex", model: "gpt-5.1-codex" });
        expect(run).toMatchObject({ id: expect.any(String) });
        await turnRunOf(fleet.conversations, "top-1")?.waitUntilFinished();
        const summary = fleet.agents.get("top-1");
        expect(summary).toMatchObject({ failureCode: "rate_limit", limitResetsAt: RESETS_AT, limitHeld: true });
        expect([summary?.limitPolicy, summary?.limitScheduled]).toEqual([undefined, undefined]);
    });
});

describe("on a box short of memory", () => {
    const GIB = 1024 ** 3;
    // 15 of 16 GiB used: short of the two a background turn needs; `oomKills` is the kernel's running count.
    const box =
        (freeGib: number, oomKills = 0) =>
        (): MemoryReading => ({
            limitBytes: 16 * GIB,
            usedBytes: (16 - freeGib) * GIB,
            swapBytes: 0,
            stallPercent: 0,
            oomKills,
        });

    // Polls the roster until the child reads `status`, so an assertion never races the detached start.
    const rosterReads = async (id: string, status: string): Promise<SubagentSession | undefined> => {
        for (let attempt = 0; attempt < 400; attempt += 1) {
            const row = listSubagentSessions(actors).find((session) => session.id === id);
            if (row?.status === status) {
                return row;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return listSubagentSessions(actors).find((session) => session.id === id);
    };

    it("a child waits as pending, saying why, and its turn runs once there is room", async () => {
        let free = 1;
        const turns: AgentTurn[] = [];
        const services = drivenBy(
            spawnServices({}, [], actors, () => box(free)()),
            fakeTurn(turns),
        );
        const result = await spawnChild(services, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        expect(await rosterReads(result.id, "pending")).toMatchObject({
            status: "pending",
            summary: "Waiting for memory: Sandbox memory is low: 15.0 GiB of 16.0 GiB used.",
        });
        expect(turns).toEqual([]);
        // Queued is not mid-turn: there is nothing to steer yet, and it says what to do instead.
        expect(await sendToChild(services, parent, result.id, "also do the docs")).toEqual({
            ok: false,
            message: "It is waiting for memory and has not started: wait for it, then send again.",
        });
        free = 8;
        await settled(result.id);
        expect(turns.map((turn) => turn.prompt)).toEqual(["go"]);
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)?.status).toBe("completed");
    });

    // A child sent to a runner uses that machine's memory, not this one's: it neither waits on this box nor holds any of it.
    it("a child placed on a runner starts at once on a short box, and holds nothing here", async () => {
        const turns: AgentTurn[] = [];
        const services = drivenBy(spawnServices({}, [{ id: "rig", online: true }], actors, box(1)), fakeTurn(turns));
        const result = await spawnChild(services, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(turns.map((turn) => turn.placement)).toEqual([{ kind: "runner", id: "rig" }]);
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)?.status).toBe("completed");
        expect((await services.resources.snapshot()).reservedBytes).toBe(0);
    });

    // The runtime's death as the SDK reports it; the fake bumps the kernel's count mid-turn, as an OOM kill does.
    const killedBy = (kills: { count: number }, message: string): TurnStarter["stream"] =>
        async function* killed() {
            kills.count += 1;
            yield { kind: "error", message };
            yield { kind: "done" };
        };

    it("a runtime killed while the OOM killer moved settles killed, with the way back", async () => {
        const kills = { count: 3 };
        const services = drivenBy(
            spawnServices({}, [], actors, () => box(8, kills.count)()),
            killedBy(kills, "Claude Code process terminated by signal SIGKILL"),
        );
        const result = await spawnChild(services, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        const row = listSubagentSessions(actors).find((session) => session.id === result.id);
        expect(row?.status).toBe("killed");
        expect(row?.error).toBe(
            "Killed when the sandbox ran out of memory (Claude Code process terminated by signal SIGKILL). Its session is intact: " +
                "`send` it a message and it carries on from where it stopped, once there is room for it. Starting more agents now " +
                "meets the same wall; have fewer run at once, and their builds and tests one at a time.",
        );
    });

    it("a runtime killed with memory to spare is named killed from outside, still with the way back", async () => {
        const services = drivenBy(
            spawnServices({}, [], actors, box(8)),
            fakeTurn([], [{ kind: "error", message: "Claude Code process exited with code 143" }, { kind: "done" }]),
        );
        const result = await spawnChild(services, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)).toMatchObject({
            status: "killed",
            error: "Killed from outside its turn (Claude Code process exited with code 143). Its session is intact: `send` it a message and it carries on from where it stopped.",
        });
    });

    it("a failure of the child's own stays failed, in its own words", async () => {
        const roomy = drivenBy(
            spawnServices({}, [], actors, box(8)),
            fakeTurn([], [{ kind: "error", message: "Claude Code process exited with code 1" }, { kind: "done" }]),
        );
        const result = await spawnChild(roomy, parent, { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)).toMatchObject({
            status: "failed",
            error: "Claude Code process exited with code 1",
        });
    });
});

// A child's turn is journalled like any the daemon starts, so a container recreate resumes it while its parent waits.
describe("a child's turn across a container recreate", () => {
    it("is held in the turn journal while it runs, and marked a journalled run for the invariant", async () => {
        const gate = Promise.withResolvers<void>();
        const body = async function* (): AsyncGenerator<AgentEvent> {
            await gate.promise;
            yield { kind: "done" };
        };
        const result = await spawnChild(drivenBy(spawnServices({}, [], actors), body), parent, {
            prompt: "go",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        const run = await (async () => {
            for (let attempt = 0; attempt < 400; attempt += 1) {
                const live = turnRunOf(actors, result.id);
                if (live !== undefined) {
                    return live;
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            return undefined;
        })();
        expect(run?.journalled).toBe(true);
        expect(actors.state(result.id)?.journal?.entry).toMatchObject({ kind: "turn", turn: { conversationId: result.id, prompt: "go" } });
        gate.resolve();
        await settled(result.id);
    });
});

describe("what a parent reads of a child's report", () => {
    it("keeps the whole closing message for the wait that hands it over, past what the row's summary holds", async () => {
        const long = `${"Found-it;".repeat(700)}THE-END`;
        const result = await spawnChild(
            drivenBy(spawnServices({}, [], actors), fakeTurn([], [{ kind: "delta", text: long }, { kind: "text_end" }, { kind: "done" }])),
            parent,
            { prompt: "go", provider: "claude", model: "claude-sonnet-4-6" },
        );
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)?.summary?.length).toBe(500);
        expect(childReportOf(actors, result.id)).toBe(long.trim());
    });

    it("keeps the spawn's description on a follow-up, and shows what the follow-up asked beside it", async () => {
        const gate = Promise.withResolvers<void>();
        const body = async function* (input: AgentTurn): AsyncGenerator<AgentEvent> {
            if (input.prompt === "Now the lexer too.") {
                await gate.promise;
            }
            yield { kind: "done" };
        };
        const services = drivenBy(spawnServices({}, [], actors), body);
        const result = await spawnChild(services, parent, {
            prompt: "port it",
            description: "Port the parser",
            provider: "claude",
            model: "claude-sonnet-4-6",
        });
        if (!result.ok) {
            throw new Error(result.message);
        }
        await settled(result.id);
        await sendToChild(services, parent, result.id, "Now the lexer too.");
        expect(listSubagentSessions(actors).find((session) => session.id === result.id)).toMatchObject({
            status: "running",
            description: "Port the parser",
            summary: "Follow-up: Now the lexer too.",
        });
        gate.resolve();
        await settled(result.id);
    });
});
