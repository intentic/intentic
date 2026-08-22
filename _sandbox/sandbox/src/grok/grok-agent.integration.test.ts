import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { resolveRequest } from "../agent/agent-requests.js";
import { createGrokAgent, type GrokRunner, type GrokTurn } from "./grok-agent.js";

/* THE HALF OF THE ADAPTER THAT TOUCHES DISK: an attached screenshot is read off the filesystem and sent to the
 * model as a PICTURE, rather than named in the prompt for the read tool to go and fetch.
 *
 * This runtime used to put every attachment in the prompt as a path and leave the fetching to the model. On the
 * Google backend that route was blocked outright (see geminiProviderConfig in opencode.ts) and the reply was
 * "I can't view the image"; even where it worked it was a round trip a screenshot does not need. Codex, Pi and
 * ACP have always split images out. Real files here because the split IS the file read: a fake would only
 * re-assert the code's own shape. Everything else (event mapping, plan flow, the self-heal) stays in the unit
 * suite next door. */

// Same fake runner the unit suite uses: one canned OpenCode Event list per invocation, capturing each turn.
const fakeRunner = (...turns: unknown[][]): { runner: GrokRunner; calls: GrokTurn[] } => {
    const calls: GrokTurn[] = [];
    const runner: GrokRunner = async function* (turn) {
        calls.push(turn);
        yield* (turns[Math.min(calls.length - 1, turns.length - 1)] ?? []) as Event[];
    };
    return { runner, calls };
};

const request = { prompt: "what is wrong with this screen?", cwd: WORKSPACE_ROOT, signal: new AbortController().signal };

// `onPlan` schedules a decision for each plan frame AFTER the generator parks on the pending-plan bridge (the
// yield suspends before wait() registers, hence the macrotask).
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

// The eight bytes every PNG starts with: enough to be read, small enough to assert byte for byte.
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
    // A PDF is still named in the prompt: the read tool handles those, and they are not what was broken.
    expect(turn.prompt).toContain(report);
    // An image that will not open degrades into the same note rather than taking the turn down with it.
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

    // Plan then execute, both on the one session: re-sending would pay for the same screenshot twice.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.images).toHaveLength(1);
    expect(calls[1]!.images).toBeUndefined();

    await rm(dir, { recursive: true, force: true });
});
