import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { createOpenCodeAgent, type OpenCodeRunner, type OpenCodeTurn, type OpenCodeTurnEvent, type TurnSession } from "./opencode-agent.js";
import type { EventOf } from "./opencode-frames.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE } from "../decorators/plan-mode.js";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { memoryFleet } from "../../testing.js";

// The real filesystem read behind attached images, which the faked runner in opencode-agent.test.ts cannot exercise.

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// One canned list of the runner's events per invocation (a plan turn calls it once per phase), capturing each turn.
const fakeRunner = (...turns: (readonly OpenCodeTurnEvent[])[]): { runner: OpenCodeRunner; calls: OpenCodeTurn[] } => {
    const calls: OpenCodeTurn[] = [];
    const runner: OpenCodeRunner = async function* (turn) {
        calls.push(turn);
        yield* turns[Math.min(calls.length - 1, turns.length - 1)] ?? [];
    };
    return { runner, calls };
};

// The session a turn runs on, as the runner says it before any of the session's events.
const session = (sessionId: string, created: boolean): TurnSession => ({ type: "intentic.session", sessionId, created });
const textDelta = (sessionID: string, delta: string): EventOf<"session.text.delta"> => ({
    id: "evt_text",
    created: 1,
    type: "session.text.delta",
    data: { sessionID, assistantMessageID: "m1", ordinal: 0, delta },
});
const succeeded = (sessionID: string): EventOf<"session.execution.succeeded"> => ({
    id: "evt_done",
    created: 2,
    type: "session.execution.succeeded",
    durable: { aggregateID: sessionID, seq: 2, version: 1 },
    data: { sessionID },
});

const request: AgentRequest<ContainerCredential> = {
    execution: unstubbed("execution", {}),
    spec: { prompt: "what is wrong with this screen?", cwd: WORKSPACE_ROOT },
    policy: {},
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
};

// Approves each plan as it is proposed; resolved on a timer, since the generator's yield suspends before the plan card's
// wait registers.
const collect = async (agent: ReturnType<typeof createOpenCodeAgent>, turnRequest: AgentRequest<ContainerCredential>): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan") {
            setTimeout(() => cards.resolve({ kind: "plan", requestId: event.requestId, approve: true }), 0);
        }
    }
    return events;
};

// Minimal valid PNG signature, enough to satisfy a real file read in the test.
const PNG_HEADER = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_URI = `data:image/png;base64,${PNG_HEADER.toString("base64")}`;

test("attached images ride as data URLs while other files and an unreadable image are named in the prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-images-"));
    const shot = join(dir, "shot.png");
    await writeFile(shot, PNG_HEADER);
    const report = join(dir, "report.pdf");
    await writeFile(report, "report");
    const missing = join(dir, "deleted.png");

    const { runner, calls } = fakeRunner([]);
    await collect(createOpenCodeAgent(runner), { ...request, spec: { ...request.spec, attachments: [shot, missing, report] } });

    expect(calls.map((call) => ({ prompt: call.prompt, images: call.images }))).toEqual([
        {
            // An unreadable image degrades to a path note instead of failing the turn; the picture itself is not named.
            prompt: `what is wrong with this screen?\n\nThe user attached these files: read them as needed:\n- ${report}\n- ${missing}`,
            images: [{ uri: PNG_URI, name: "shot.png" }],
        },
    ]);

    await rm(dir, { recursive: true, force: true });
});

test("a plan turn sends attached images on the first planning message only: the resumed session already holds them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-plan-images-"));
    const shot = join(dir, "shot.png");
    await writeFile(shot, PNG_HEADER);

    const { runner, calls } = fakeRunner(
        [session("s1", true), textDelta("s1", "The plan."), succeeded("s1")],
        [session("s1", false), succeeded("s1")],
    );
    await collect(createOpenCodeAgent(runner), {
        ...request,
        spec: { ...request.spec, attachments: [shot] },
        policy: { ...request.policy, permissionMode: "plan" },
    });

    expect(calls.map((call) => ({ agent: call.agent, prompt: call.prompt, sessionId: call.sessionId, images: call.images }))).toEqual([
        { agent: "plan", prompt: `${PLAN_PREAMBLE}what is wrong with this screen?`, sessionId: undefined, images: [{ uri: PNG_URI, name: "shot.png" }] },
        { agent: "build", prompt: EXECUTE_PROMPT, sessionId: "s1", images: undefined },
    ]);

    await rm(dir, { recursive: true, force: true });
});
