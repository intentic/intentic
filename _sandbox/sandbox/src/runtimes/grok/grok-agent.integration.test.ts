import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolveRequest } from "../../agent/tools/agent-requests.js";
import { createGrokAgent, type GrokRunner, type GrokTurn } from "./grok-agent.js";

// Exercises the real filesystem read behind attached images: needs actual files on disk, unlike the mocked runner in
// grok-agent.test.ts.

// One canned OpenCode Event list per invocation, capturing each turn.
const fakeRunner = (...turns: unknown[][]): { runner: GrokRunner; calls: GrokTurn[] } => {
    const calls: GrokTurn[] = [];
    const runner: GrokRunner = async function* (turn) {
        calls.push(turn);
        yield* (turns[Math.min(calls.length - 1, turns.length - 1)] ?? []) as Event[];
    };
    return { runner, calls };
};

const request = { prompt: "what is wrong with this screen?", cwd: WORKSPACE_ROOT, signal: new AbortController().signal };

// `onPlan` fires via `setTimeout` because the generator's yield suspends before `wait()` registers the pending-plan
// bridge.
const collect = async (
    agent: ReturnType<typeof createGrokAgent>,
    turnRequest: Parameters<ReturnType<typeof createGrokAgent>>[0],
    onPlan?: (requestId: string) => { approve: boolean; feedback?: string },
): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent(turnRequest)) {
        events.push(event);
        if (event.kind === "plan" && onPlan !== undefined) {
            const decision = onPlan(event.requestId);
            setTimeout(() => resolveRequest({ kind: "plan", requestId: event.requestId, ...decision }), 0);
        }
    }
    return events;
};

// Minimal valid PNG signature, enough to satisfy a real file read in the test.
const PNG_HEADER = Buffer.from("89504e470d0a1a0a", "hex");

test("attached images ride as native picture parts while other files stay referenced by path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-images-"));
    const shot = join(dir, "shot.png");
    await writeFile(shot, PNG_HEADER);
    const report = join(dir, "report.pdf");
    await writeFile(report, "report");
    const missing = join(dir, "deleted.png");

    const { runner, calls } = fakeRunner([]);
    await collect(createGrokAgent(runner), { ...request, attachments: [shot, missing, report] });

    const turn = calls[0]!;
    expect(turn.images).toEqual([
        { type: "file", mime: "image/png", filename: "shot.png", url: `data:image/png;base64,${PNG_HEADER.toString("base64")}` },
    ]);
    expect(turn.prompt).toContain(report);
    // An unreadable image degrades to a path note instead of failing the turn.
    expect(turn.prompt).toContain(missing);
    expect(turn.prompt).not.toContain(shot);

    await rm(dir, { recursive: true, force: true });
});

test("a plan turn sends attached images on the first planning message only: the resumed session already holds them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-plan-images-"));
    const shot = join(dir, "shot.png");
    await writeFile(shot, PNG_HEADER);

    const { runner, calls } = fakeRunner(
        [
            { type: "session.created", properties: { info: { id: "s1" } } },
            { type: "message.part.updated", properties: { part: { type: "text", sessionID: "s1", text: "The plan." } } },
            { type: "session.idle", properties: { sessionID: "s1" } },
        ],
        [{ type: "session.idle", properties: { sessionID: "s1" } }],
    );
    await collect(createGrokAgent(runner), { ...request, permissionMode: "plan", attachments: [shot] }, () => ({ approve: true }));

    expect(calls).toHaveLength(2);
    expect(calls[0]!.images).toHaveLength(1);
    expect(calls[1]!.images).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
});
