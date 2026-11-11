import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Device, DeviceFlowLine, DeviceSandbox, DeviceSandboxFlow } from "@intentic/sandbox-contract/schemas/devices";
import type { DeviceFacts } from "@intentic/sandbox-contract/schemas/hosts";
import type { CliAnswer } from "../http/cli-answer.js";
import { waitFor } from "@intentic/testing/bun";
import { z } from "zod";
import { approveMove, type MoveAsk, type MoveGateDeps, type MoveProgress, progressOf, type RelayEnd, runMove } from "./move-gate.js";
import { parkedCards } from "../conversations/actor/parked-cards.js";
import { createHeldCards } from "../guard/held-cards.js";
import { memoryFleet } from "../conversations/registry/agents-registry.testing.js";

// The gate's job is to refuse before anything moves, to show the owner the size on the card, and, after a yes, to
// carry the two computers' public keys between their flows and relay their bytes when they cannot meet, without ever
// handing a key back to the CLI. Each computer's ic does the copy and rolls itself back; that is ic's own suite.

const cards = parkedCards(memoryFleet().conversations);

const MOVE = (step: Record<string, unknown>): DeviceFlowLine => ({ kind: "line", text: `intentic-move: ${JSON.stringify(step)}` });
const PLAN = { v: 1, slug: "sandbox-850b3ad46a90", bytes: 12_400_000_000, running: true };
const TARGET_KEY = "dGFyZ2V0LWtleQ";
const SOURCE_KEY = "c291cmNlLWtleQ";

const facts = (features: string[]): DeviceFacts => ({ os: "Arch Linux", arch: "x64", shell: "/bin/bash", home: "/home/radarsu", roots: ["/home/radarsu"], features });

const device = (hostId: string, over: Partial<Device> = {}): Device => ({
    key: hostId,
    label: hostId,
    hostId,
    card: hostId,
    machineId: `${hostId}-machine`,
    online: true,
    facts: facts(["sandbox-move"]),
    sandboxes: [],
    ...over,
});

const TRANSLATIONS: DeviceSandbox = {
    slug: "sandbox-850b3ad46a90",
    container: "intentic-sandbox-sandbox-850b3ad46a90",
    name: "translations",
    running: true,
    image: "ghcr.io/intentic/sandbox:stable",
};
const ROG = device("rog", { sandboxes: [TRANSLATIONS] });
const Z440 = device("z440");

type Flows = Record<string, (flow: DeviceSandboxFlow) => DeviceFlowLine[]>;

// Each op answers with its scripted lines; `move-in` and the relay are recorded so the hand-offs can be asserted.
const fake = (over: Partial<MoveGateDeps> = {}, flows: Flows = {}) => {
    const frames: AgentEvent[] = [];
    const sent: { readonly id: string; readonly flow: DeviceSandboxFlow }[] = [];
    const relays: [RelayEnd, RelayEnd][] = [];
    const closed: number[] = [];
    const turn = Promise.withResolvers<void>();
    const deps: MoveGateDeps = {
        cards,
        liveRun: (conversationId) => ({ conversationId: conversationId ?? "sole-conv", push: (event) => frames.push(event) }),
        observe: () => {},
        awaiting: () => {},
        hold: { held: createHeldCards(async () => undefined), finished: () => turn.promise },
        devices: async () => [ROG, Z440],
        manages: async () => true,
        selfSlug: () => "sandbox-aaaaaaaaaaaa",
        moveId: () => "0123456789abcdef",
        async *runFlow(id, flow) {
            sent.push({ id, flow });
            const key = flow.op === "move-out" ? `move-out:${flow.move?.stage}` : flow.op;
            yield* flows[key]?.(flow) ?? [{ kind: "result", message: "done" }];
        },
        relay: async (from, to) => {
            relays.push([from, to]);
            return { close: async () => void closed.push(1) };
        },
        ...over,
    };
    return { deps, frames, sent, relays, closed, endTurn: () => turn.resolve() };
};

const ask = (over: Partial<MoveAsk> = {}): MoveAsk => ({
    name: "translations",
    to: "z440",
    manager: undefined,
    why: "z440 has the disk and stays on",
    conversationId: "conv-1",
    signal: new AbortController().signal,
    ...over,
});

const planned = { "move-out:plan": () => [MOVE({ step: "plan", plan: PLAN }), { kind: "result", message: "planned" }] } satisfies Flows;

const answerCard = async (frames: AgentEvent[], label: string): Promise<string> => {
    await waitFor(() => expect(frames).toHaveLength(1));
    const raised = frames[0]!;
    if (raised.kind !== "question") {
        throw new Error(`expected a question frame, got ${raised.kind}`);
    }
    const question = raised.questions[0]!;
    cards.resolve({ kind: "question", requestId: raised.requestId, answers: { [question.question]: [label] } });
    return `${question.question}\n${question.options.map((option) => option.description).join("\n")}`;
};

// A refusal's status and its error's type and sentence; anything else (an approval) fails the test that expected one.
const RefusalBodySchema = z.object({ error: z.object({ type: z.string(), message: z.string() }) });
const refusalOf = (answer: CliAnswer | object) => {
    if (!("status" in answer && "body" in answer)) {
        throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
    }
    return { status: answer.status, ...RefusalBodySchema.parse(JSON.parse(answer.body)).error };
};

describe("refusals before anything moves", () => {
    it("names what does run when no linked computer runs the sandbox", async () => {
        const { deps, sent } = fake();
        expect(refusalOf(await approveMove(deps, ask({ name: "nope" })))).toMatchObject({ status: 404, type: "no_such_sandbox" });
        expect(sent).toEqual([]);
    });

    it("refuses to move the sandbox it runs in, and says where to run it from", async () => {
        const { deps } = fake({ selfSlug: () => "sandbox-850b3ad46a90" });
        const refused = refusalOf(await approveMove(deps, ask()));
        expect(refused.type).toBe("self");
        expect(refused.message).toContain("from another of the owner's sandboxes");
    });

    it("refuses a target this sandbox does not reach", async () => {
        const { deps } = fake();
        expect(refusalOf(await approveMove(deps, ask({ to: "omen" })))).toMatchObject({ status: 409, type: "no_such_device" });
    });

    it("refuses a move onto the computer that already runs it, a second door of one machine included", async () => {
        const wsl = device("rog::wsl:archlinux", { machineId: "rog-machine", card: "rog-wsl" });
        const { deps } = fake({ devices: async () => [ROG, wsl] });
        expect(refusalOf(await approveMove(deps, ask({ to: "rog" }))).type).toBe("same_device");
        expect(refusalOf(await approveMove(deps, ask({ to: "rog::wsl:archlinux" }))).type).toBe("same_device");
    });

    it("refuses when either side's agent or ic cannot move sandboxes, naming the one to update", async () => {
        const old = device("z440", { facts: facts([]) });
        const { deps, sent } = fake({ devices: async () => [ROG, old] });
        const refused = refusalOf(await approveMove(deps, ask()));
        expect(refused.type).toBe("unsupported");
        expect(refused.message).toContain("The agent on z440");
        expect(sent).toEqual([]);
    });

    it("refuses when Manage sandboxes is off on either computer", async () => {
        const { deps } = fake({ manages: async (card) => card !== "z440" });
        const refused = refusalOf(await approveMove(deps, ask()));
        expect(refused.type).toBe("switch_off");
        expect(refused.message).toContain("capabilities request z440 --set sandboxes=on");
    });

    it("answers the source's own failure to plan, before any card", async () => {
        const { deps, frames } = fake({}, { "move-out:plan": () => [{ kind: "error", message: "docker is not running" }] });
        const refused = refusalOf(await approveMove(deps, ask()));
        expect(refused.type).toBe("plan_failed");
        expect(refused.message).toContain("docker is not running");
        expect(frames).toEqual([]);
    });
});

describe("the owner's card", () => {
    it("names the sandbox, both computers, the size and that it is offline for the copy, after the plan", async () => {
        const { deps, frames, sent } = fake({}, planned);
        const approved = approveMove(deps, ask());
        const text = await answerCard(frames, "Move it");
        expect(text).toContain(`Move the sandbox "translations" from rog to z440?`);
        expect(text).toContain("about 12.4 GB");
        expect(text).toContain("offline for the whole copy");
        expect(text).toContain("z440 has the disk and stays on");
        expect(await approved).toEqual({
            route: { slug: "sandbox-850b3ad46a90", label: "translations", source: "rog", target: "z440" },
            id: "0123456789abcdef",
            plan: PLAN,
        });
        expect(sent.map(({ id, flow }) => [id, flow.op, flow.move?.stage])).toEqual([["rog", "move-out", "plan"]]);
    });

    it("moves nothing on a no", async () => {
        const { deps, frames, sent } = fake({}, planned);
        const approved = approveMove(deps, ask());
        await answerCard(frames, "Not now");
        expect(refusalOf(await approved).type).toBe("declined");
        expect(sent).toHaveLength(1);
    });
});

const ROUTE = { slug: "sandbox-850b3ad46a90", label: "translations", source: "rog", target: "z440" };
const START = { id: "0123456789abcdef", plan: PLAN, manager: undefined };
const READY = MOVE({ step: "ready", publicKey: TARGET_KEY, listen: ["192.168.1.40:41234"], port: 41234 });

describe("the move after a yes", () => {
    it("hands each side the other's key through the daemon and never shows one to the CLI", async () => {
        const { deps, sent, relays } = fake(
            {},
            {
                "move-prepare": () => [READY, MOVE({ step: "volume", volume: "intentic-workspace-x", done: 10, total: 20 }), MOVE({ step: "moved" })],
                "move-out:send": () => [MOVE({ step: "key", publicKey: SOURCE_KEY }), MOVE({ step: "stopping" }), MOVE({ step: "moved" })],
            },
        );
        const progress: MoveProgress[] = [];
        const answer = await runMove(deps, ROUTE, START, (line) => progress.push(line));
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body)).toEqual({ moved: "translations", slug: "sandbox-850b3ad46a90", from: "rog", to: "z440", manager: "ic" });
        const send = sent.find(({ flow }) => flow.move?.stage === "send");
        expect(send?.flow.move).toEqual({ id: "0123456789abcdef", stage: "send", peer: TARGET_KEY, connect: ["192.168.1.40:41234"], listen: true });
        const handed = sent.find(({ flow }) => flow.op === "move-in");
        expect(handed).toEqual({ id: "z440", flow: { op: "move-in", slug: "sandbox-850b3ad46a90", move: { id: "0123456789abcdef", peer: SOURCE_KEY } } });
        expect(relays).toEqual([]);
        const shown = JSON.stringify(progress);
        expect(shown).not.toContain(TARGET_KEY);
        expect(shown).not.toContain(SOURCE_KEY);
        expect(progress).toContainEqual({ side: "target", step: "volume", volume: "intentic-workspace-x", done: 10, total: 20 });
    });

    it("relays between the two loopback ports when the source has to listen, and closes the relay after", async () => {
        const { deps, relays, closed } = fake(
            {},
            {
                "move-prepare": () => [READY, MOVE({ step: "moved" })],
                "move-out:send": () => [MOVE({ step: "key", publicKey: SOURCE_KEY }), MOVE({ step: "listening", port: 50111 }), MOVE({ step: "moved" })],
            },
        );
        const answer = await runMove(deps, ROUTE, START, () => {});
        expect(answer.status).toBe(200);
        expect(relays).toEqual([[{ device: "rog", port: 50111 }, { device: "z440", port: 41234 }]]);
        expect(closed).toEqual([1]);
    });

    it("reports a failed send as the sandbox back where it was, with each side's reason", async () => {
        const { deps } = fake(
            {},
            {
                "move-prepare": () => [READY],
                "move-out:send": () => [
                    MOVE({ step: "key", publicKey: SOURCE_KEY }),
                    MOVE({ step: "failed", reason: "the copy of intentic-history-x does not match" }),
                    { kind: "error", message: "That move-out failed on this device." },
                ],
            },
        );
        const refused = refusalOf(await runMove(deps, ROUTE, START, () => {}));
        expect(refused.type).toBe("move_failed");
        expect(refused.message).toContain("It is back on rog as it was");
        expect(refused.message).toContain("the copy of intentic-history-x does not match");
    });

    it("starts the source again when it lost the verdict and the target failed, and not when the target is up", async () => {
        const lostVerdict = MOVE({ step: "failed", reason: "the connection broke after the end of the stream", ambiguous: true });
        const failedThere = fake(
            {},
            {
                "move-prepare": () => [READY, MOVE({ step: "failed", reason: "the daemon never registered its tunnel" })],
                "move-out:send": () => [MOVE({ step: "key", publicKey: SOURCE_KEY }), lostVerdict],
            },
        );
        const refused = refusalOf(await runMove(failedThere.deps, ROUTE, START, () => {}));
        expect(refused.message).toContain("rog was asked to start it again where it was");
        expect(failedThere.sent.map(({ id, flow }) => [id, flow.op])).toContainEqual(["rog", "start"]);

        const upThere = fake({}, { "move-prepare": () => [READY, MOVE({ step: "moved", host: "z440" })], "move-out:send": () => [lostVerdict] });
        const answer = await runMove(upThere.deps, ROUTE, START, () => {});
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body)).toMatchObject({ moved: "translations", note: expect.stringContaining("remove it once you are sure") });
        expect(upThere.sent.map(({ flow }) => flow.op)).not.toContain("start");
    });

    it("never starts the source when the target cannot get ready", async () => {
        const { deps, sent } = fake({}, { "move-prepare": () => [MOVE({ step: "failed", reason: "only 3.1 GB free" }), { kind: "error", message: "failed" }] });
        const refused = refusalOf(await runMove(deps, ROUTE, START, () => {}));
        expect(refused.type).toBe("target_failed");
        expect(refused.message).toContain("only 3.1 GB free");
        expect(sent.map(({ flow }) => flow.op)).toEqual(["move-prepare"]);
    });
});

it("keeps a step's own fields in progress and drops narration that is blank", () => {
    expect(progressOf("source", MOVE({ step: "volume", volume: "v", done: 1, total: 2 }))).toEqual({ side: "source", step: "volume", volume: "v", done: 1, total: 2 });
    expect(progressOf("target", READY)).toBeUndefined();
    expect(progressOf("target", { kind: "line", text: "  " })).toBeUndefined();
    expect(progressOf("target", { kind: "line", text: "pulling ghcr.io/intentic/sandbox" })).toEqual({ side: "target", text: "pulling ghcr.io/intentic/sandbox" });
});
