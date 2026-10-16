import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { DeviceFlowLine, DeviceSandboxFlow } from "@intentic/sandbox-contract/schemas/devices";
import { type CreateAsk, createSandboxThroughFleet, type FleetGateDeps, type RemoveAsk, removeSandboxThroughFleet, slugOf } from "./fleet-gate.js";
import { parkedCards } from "../conversations/actor/parked-cards.js";
import { createHeldCards } from "../guard/held-cards.js";
import { memoryFleet } from "../conversations/registry/agents-registry.testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// The gate's whole job is ORDER: the owner's card comes before the account is touched, so a no costs nothing at all —
// no row, no claim, nothing left to expire. Everything else here is what each way of not saying yes answers with.

const PROVISIONED = {
    sandboxId: "sbx-new",
    name: "reviewer",
    hostname: "sandbox-abc123def456.sbx.test",
    setupCode: "CODE123",
    expiresAt: "2026-09-21T12:30:00.000Z",
};

const ok = (payload: unknown) => ({ status: 200, body: JSON.stringify(payload), contentType: "application/json" });

interface Fake {
    readonly deps: FleetGateDeps;
    readonly frames: AgentEvent[];
    readonly provision: ReturnType<typeof jest.fn>;
    readonly flows: DeviceSandboxFlow[];
    // Ends the turn the card went up in, which settles a card nobody answered.
    readonly endTurn: () => void;
}

const fake = (
    over: Partial<FleetGateDeps> = {},
    lines: DeviceFlowLine[] = [{ kind: "result", message: `Created sandbox "sandbox-abc123def456".` }],
): Fake => {
    const frames: AgentEvent[] = [];
    const flows: DeviceSandboxFlow[] = [];
    const provision = jest.fn(async () => ok(PROVISIONED));
    const turn = Promise.withResolvers<void>();
    const held = createHeldCards(async () => undefined);
    const deps: FleetGateDeps = {
        cards,
        token: async () => "itk_test",
        list: async () => ok({ sandboxes: [] }),
        provision,
        devices: async () => ({ ids: ["radarsu-rog"], self: "radarsu-rog" }),
        async *runFlow(id, flow) {
            flows.push(flow);
            void id;
            yield* lines;
        },
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: () => {},
        awaiting: () => {},
        hold: { held, finished: () => turn.promise },
        remove: async () => ok({ name: "trashed", recoverableUntil: "2026-10-22T19:00:00.000Z" }),
        runsOn: async () => undefined,
        selfUrl: () => "https://sandbox-82789f4106b4.sbx.test",
        ...over,
    };
    return { deps, frames, provision, flows, endTurn: () => turn.resolve() };
};

const ask = (over: Partial<CreateAsk> = {}): CreateAsk => ({
    name: "reviewer",
    on: undefined,
    definition: undefined,
    why: "somewhere to run the nightly review without competing for this box's cores",
    conversationId: "conv-1",
    signal: new AbortController().signal,
    ...over,
});

// The requestId only exists inside the pushed frame: wait for it, then answer as POST /agent/reply would.
const answerCard = async (frames: AgentEvent[], label: string | undefined): Promise<void> => {
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const raised = frames[0]!;
    if (raised.kind !== "question") {
        throw new Error(`expected a question frame, got ${raised.kind}`);
    }
    cards.resolve(
        label === undefined
            ? { kind: "question", requestId: raised.requestId, cancelled: true }
            : { kind: "question", requestId: raised.requestId, answers: { [raised.questions[0]!.question]: [label] } },
    );
};

it("derives the slug from the hostname the platform minted, which is what the container will be called", () => {
    expect(slugOf("sandbox-abc123def456.sbx.test")).toBe("sandbox-abc123def456");
});

it("asks first, then provisions and builds, reporting where it landed", async () => {
    const { deps, frames, provision, flows } = fake();
    const pending = createSandboxThroughFleet(deps, ask());
    await answerCard(frames, "Create it");
    const answer = await pending;
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({
        sandboxId: "sbx-new",
        name: "reviewer",
        on: "radarsu-rog",
        url: "https://sandbox-abc123def456.sbx.test",
    });
    // The claim reached the machine as a `create`, under the slug the hostname names.
    expect(flows[0]).toEqual({ op: "create", slug: "sandbox-abc123def456", setupCode: "CODE123" });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.kind)).toEqual(["question", "resolved"]);
});

// The question card draws an option's label, description and preview and nothing else, so the agent's case goes where
// the owner reads it. Pinned whole: a `why` riding beside those fields, which no card draws, fails here.
it("shows the owner the agent's case, on the create it argues for", async () => {
    const { deps, frames } = fake();
    const pending = createSandboxThroughFleet(deps, ask());
    await answerCard(frames, "Not now");
    await pending;
    expect(frames[0]).toEqual({
        kind: "question",
        requestId: expect.any(String),
        questions: [
            {
                question: 'Create a new sandbox "reviewer" on radarsu-rog?',
                header: "New sandbox",
                multiSelect: false,
                options: [
                    {
                        label: "Create it",
                        description:
                            "Makes it on your intentic account and brings it up on radarsu-rog. It is yours, and it outlives this conversation. The agent's case: somewhere to run the nightly review without competing for this box's cores",
                    },
                    { label: "Not now", description: "Nothing is created and nothing is spent." },
                ],
            },
        ],
    });
});

it("says nothing of a case the agent did not make", async () => {
    for (const why of [undefined, ""]) {
        const { deps, frames } = fake();
        const pending = createSandboxThroughFleet(deps, ask({ why }));
        await answerCard(frames, "Not now");
        await pending;
        const raised = frames[0];
        expect(raised?.kind === "question" ? raised.questions[0]?.options : raised?.kind, JSON.stringify(why)).toEqual([
            {
                label: "Create it",
                description: "Makes it on your intentic account and brings it up on radarsu-rog. It is yours, and it outlives this conversation.",
            },
            { label: "Not now", description: "Nothing is created and nothing is spent." },
        ]);
    }
});

it("a no touches the account at all: nothing is minted, so there is nothing to expire", async () => {
    const { deps, frames, provision, flows } = fake();
    const pending = createSandboxThroughFleet(deps, ask());
    await answerCard(frames, "Not now");
    const answer = await pending;
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "declined" } });
    expect(provision).not.toHaveBeenCalled();
    expect(flows).toHaveLength(0);
});

it("a dismissed card is not a yes, and says so as its own refusal", async () => {
    const { deps, frames, provision } = fake();
    const pending = createSandboxThroughFleet(deps, ask());
    await answerCard(frames, undefined);
    const answer = await pending;
    // Dismissed, not expired: a person answered, they just did not choose the create.
    expect(answer.status).toBe(409);
    expect(provision).not.toHaveBeenCalled();
});

it("a card nobody answered before the turn ended creates nothing", async () => {
    const { deps, provision, frames, endTurn } = fake();
    const pending = createSandboxThroughFleet(deps, ask());
    while (frames.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    endTurn();
    const answer = await pending;
    expect(answer.status).toBe(408);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "unanswered" } });
    expect(provision).not.toHaveBeenCalled();
});

it("refuses before the card when no account is connected", async () => {
    const { deps, frames } = fake({ token: async () => undefined });
    const answer = await createSandboxThroughFleet(deps, ask());
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "no_fleet" } });
    // No card at all: there is nothing to decide when the sandbox cannot act on the account either way.
    expect(frames).toHaveLength(0);
});

it("refuses a machine that is not connected instead of quietly building somewhere else", async () => {
    const { deps, frames } = fake();
    const answer = await createSandboxThroughFleet(deps, ask({ on: "someone-elses-laptop" }));
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "no_such_device" } });
    expect(frames).toHaveLength(0);
});

it("names --on when several machines are connected and none is known to run this sandbox", async () => {
    const { deps } = fake({ devices: async () => ({ ids: ["rog", "omen"], self: undefined }) });
    const answer = await createSandboxThroughFleet(deps, ask());
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body).error.message).toMatch(/--on/);
});

it("reports a failed build as a name that now exists, with ic's own lines", async () => {
    const { deps, frames } = fake({}, [
        { kind: "line", text: "pulling ghcr.io/intentic/sandbox…" },
        { kind: "error", message: "no space left on device" },
    ]);
    const pending = createSandboxThroughFleet(deps, ask());
    await answerCard(frames, "Create it");
    const answer = await pending;
    expect(answer.status).toBe(502);
    const body = JSON.parse(answer.body) as { error: { type: string; message: string }; lines: string[] };
    expect(body.error.type).toBe("build_failed");
    // The row survives the failure, so the report has to say the name is taken rather than that nothing happened.
    expect(body.error.message).toMatch(/created on the account/);
    expect(body.lines).toEqual(["pulling ghcr.io/intentic/sandbox…", "no space left on device"]);
});

// 2026-10-15: after a link check, the two test sandboxes could only be removed by a person, in the app and on the
// machine. A removal now goes the create's way: the owner's card first, then the machine, else the account row.
describe("removing a sandbox", () => {
    const ACCOUNT = {
        sandboxes: [
            { id: "sbx-self", name: "intentic", url: "https://sandbox-82789f4106b4.sbx.test", lastSeenAt: "2026-10-15T19:00:00.000Z" },
            { id: "sbx-linktest", name: "linktest", url: "https://sandbox-7e8d0ffa8bed.sbx.test", lastSeenAt: "2026-10-15T19:00:00.000Z" },
            { id: "sbx-omen", name: "linktest-omen" },
            { id: "sbx-a", name: "twin" },
            { id: "sbx-b", name: "Twin" },
        ],
    };
    const removing = (over: Partial<RemoveAsk> = {}): RemoveAsk => ({
        name: "linktest",
        why: "the link check is done",
        conversationId: "conv-1",
        signal: new AbortController().signal,
        ...over,
    });
    const listed = { list: async () => ok(ACCOUNT) };

    it("asks first, then removes it on the machine that runs it, which keeps its files there", async () => {
        const remove = jest.fn(async () => ok({}));
        const { deps, frames, flows } = fake({ ...listed, remove, runsOn: async (slug) => (slug === "sandbox-7e8d0ffa8bed" ? "rog" : undefined) }, [
            { kind: "result", message: "Removed sandbox-7e8d0ffa8bed." },
        ]);
        const pending = removeSandboxThroughFleet(deps, removing());
        await answerCard(frames, "Remove it");
        const answer = await pending;
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body)).toMatchObject({ name: "linktest", removed: "machine", on: "rog" });
        expect(flows).toEqual([{ op: "remove", slug: "sandbox-7e8d0ffa8bed" }]);
        // The machine's own removal takes it off the account: the row is not trashed a second time.
        expect(remove).not.toHaveBeenCalled();
        const raised = frames[0];
        expect(raised?.kind === "question" ? raised.questions[0] : undefined).toMatchObject({
            question: 'Remove the sandbox "linktest"?',
            options: [
                { label: "Remove it", description: expect.stringContaining("`ic sandbox restore sandbox-7e8d0ffa8bed` there brings it back") },
                { label: "Keep it", description: "Nothing is removed." },
            ],
        });
    });

    it("takes a sandbox that never came up off the account alone, saying until when it can come back", async () => {
        const remove = jest.fn(async () => ok({ name: "linktest-omen", recoverableUntil: "2026-10-22T19:00:00.000Z" }));
        const { deps, frames, flows } = fake({ ...listed, remove });
        const pending = removeSandboxThroughFleet(deps, removing({ name: "linktest-omen" }));
        await answerCard(frames, "Remove it");
        const answer = await pending;
        expect(JSON.parse(answer.body)).toEqual({ name: "linktest-omen", removed: "account", recoverableUntil: "2026-10-22T19:00:00.000Z" });
        expect(remove).toHaveBeenCalledWith("itk_test", "sbx-omen");
        expect(flows).toHaveLength(0);
    });

    it("a no removes nothing anywhere", async () => {
        const remove = jest.fn(async () => ok({}));
        const { deps, frames, flows } = fake({ ...listed, remove, runsOn: async () => "rog" });
        const pending = removeSandboxThroughFleet(deps, removing());
        await answerCard(frames, "Keep it");
        const answer = await pending;
        expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "declined" } });
        expect(remove).not.toHaveBeenCalled();
        expect(flows).toHaveLength(0);
    });

    it("refuses before any card: this sandbox itself, a name nobody has, and a name two share", async () => {
        const { deps, frames } = fake(listed);
        const self = await removeSandboxThroughFleet(deps, removing({ name: "intentic" }));
        expect(JSON.parse(self.body)).toMatchObject({ error: { type: "self" } });
        const none = await removeSandboxThroughFleet(deps, removing({ name: "staging" }));
        expect(JSON.parse(none.body)).toMatchObject({ error: { type: "no_such_sandbox" } });
        const twins = await removeSandboxThroughFleet(deps, removing({ name: "twin" }));
        expect(JSON.parse(twins.body)).toMatchObject({ error: { type: "ambiguous", message: expect.stringContaining("sbx-a, sbx-b") } });
        expect(frames).toHaveLength(0);
    });

    it("refuses before the card when no account is connected", async () => {
        const { deps, frames } = fake({ token: async () => undefined });
        const answer = await removeSandboxThroughFleet(deps, removing());
        expect(JSON.parse(answer.body)).toMatchObject({ error: { type: "no_fleet" } });
        expect(frames).toHaveLength(0);
    });
});
