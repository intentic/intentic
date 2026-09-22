import type { AgentEvent, DeviceFlowLine, DeviceSandboxFlow } from "@intentic/sandbox-contract";
import { it, expect, mock } from "bun:test";
import { resolveRequest } from "../agent/tools/agent-requests.js";
import { type CreateAsk, createSandboxThroughFleet, type FleetGateDeps, slugOf } from "./fleet-gate.js";

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
    readonly provision: ReturnType<typeof mock>;
    readonly flows: DeviceSandboxFlow[];
}

const fake = (over: Partial<FleetGateDeps> = {}, lines: DeviceFlowLine[] = [{ kind: "result", message: `Created sandbox "sandbox-abc123def456".` }]): Fake => {
    const frames: AgentEvent[] = [];
    const flows: DeviceSandboxFlow[] = [];
    const provision = mock(async () => ok(PROVISIONED));
    const deps: FleetGateDeps = {
        token: async () => "itk_test",
        list: async () => ok({ sandboxes: [] }),
        provision,
        devices: async () => ({ ids: ["radarsu-rog"], self: "radarsu-rog" }),
        async *runFlow (id, flow) {
            flows.push(flow);
            void id;
            yield* lines;
        },
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: () => {},
        deadlineMs: 200,
        ...over,
    };
    return { deps, frames, provision, flows };
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
    resolveRequest(
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
    expect(JSON.parse(answer.body)).toMatchObject({ sandboxId: "sbx-new", name: "reviewer", on: "radarsu-rog", url: "https://sandbox-abc123def456.sbx.test" });
    // The claim reached the machine as a `create`, under the slug the hostname names.
    expect(flows[0]).toEqual({ op: "create", slug: "sandbox-abc123def456", setupCode: "CODE123" });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.kind)).toEqual(["question", "resolved"]);
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

it("an unanswered card expires without creating anything", async () => {
    const { deps, provision } = fake({ deadlineMs: 20 });
    const answer = await createSandboxThroughFleet(deps, ask());
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
