import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { HandoffMode, HandoffOffer } from "@intentic/sandbox-contract/schemas/providers/handoff";
import type { Services } from "../../../../composition.js";
import { services as routeServices, recordingTurnStores } from "../../../../harness/route-services.testing.js";
import { collect } from "../../../../harness/route-client.testing.js";
import { streamAgent } from "../../stream-agent.js";

/* proud-meadow-86lu, 2026-10-26: a turn held for a spent allowance, its card reading Summary, and a "Continue" booked
   for the reset. Those words took the held turn's place and resumed the old session whole: no summary was written, and
   nothing in the transcript said so. Words that take a held turn's place now go on its pick. */

let store: string;
beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), "handoff-way-"));
    await mkdir(join(store, "projects", "project"), { recursive: true });
    // The held turn's session, on disk where the runtime's store keeps it: carrying it is possible, so only the pick
    // decides whether it is carried.
    await writeFile(
        join(store, "projects", "project", "session.jsonl"),
        `${JSON.stringify({ uuid: "u0", parentUuid: null, sessionId: "session", type: "user", message: { content: "Fix the login bug" } })}\n`,
    );
});
afterEach(async () => {
    await rm(store, { recursive: true, force: true });
});

const OFFER: HandoffOffer = {
    suggested: "trim",
    basis: "size",
    carry: { tokens: 420_000 },
    trim: { tokens: 110_000, cleared: 180 },
    summary: { tokens: 40_000, reads: 300_000 },
};

const ROWS: TranscriptRow[] = [
    { role: "user", text: "Fix the login bug" },
    { role: "assistant", text: "The session cookie is set before the redirect; moving it." },
];

const SUMMARIZING = "Writing a summary of the conversation for the hand-off…";

// A conversation whose turn a spent allowance holds, its card picked `chosen`; then the person's "Continue" streams.
const continueOnto = async (chosen: HandoffMode) => {
    const recorded = recordingTurnStores();
    const sessions: (string | undefined)[] = [];
    const plain = routeServices({});
    const deps = routeServices({
        ...recorded.overrides,
        agentWorktrees: unstubbed<Services["agentWorktrees"]>("agentWorktrees", { sessionStore: () => store }),
        transcripts: { ...plain.transcripts, read: async () => ROWS },
        async *agent(request): AsyncGenerator<AgentEvent> {
            sessions.push(request.spec.sessionId);
            yield { kind: "session", sessionId: request.spec.sessionId ?? "fresh" };
            yield { kind: "delta", text: "Done." };
            yield { kind: "usage", inputTokens: 10, outputTokens: 10, costUsd: 0, numTurns: 1, durationMs: 1 };
            yield { kind: "done" };
        },
    });
    const conversationId = `held-${chosen}`;
    const profile = { provider: "claude", harness: "native" } as const;
    await deps.conversations.send(conversationId, { kind: "begin", turn: { conversationId, prompt: "Fix the login bug", isolated: false, profile } }, 1).settled;
    deps.conversations.send(conversationId, { kind: "frame", frame: { kind: "session", sessionId: "session" } }, 2);
    const input = { conversationId, prompt: "Fix the login bug", agent: "claude", harness: "native" } as const;
    const handoff = { ...OFFER, chosen };
    deps.conversations.send(conversationId, { kind: "turn-held", held: { input, reason: "limit", sessionId: "session", ran: true, contextTokens: 420_000, reopensAt: 100, handoff } }, 3);
    await deps.conversations.send(conversationId, { kind: "settle" }, 4).settled;

    const frames = await collect(streamAgent(deps, { conversationId, prompt: "Continue", agent: "claude", sessionId: "session" }, undefined));
    return { frames, sessions, held: deps.conversations.state(conversationId)?.resume.held };
};

test("words typed onto a hold picked for a summary open a fresh session on one, not the old session whole", async () => {
    const { frames, sessions, held } = await continueOnto("summary");

    expect(frames).toContainEqual({ kind: "agent_status", key: "handoff", text: SUMMARIZING });
    expect(frames.find((frame) => frame.kind === "handoff")).toMatchObject({ kind: "handoff", mode: "summary" });
    // The turn's own request, the last one out (a summary's model call may go before it), names no session.
    expect(sessions.at(-1)).toBeUndefined();
    // The words took the held turn's place: nothing is left to send again.
    expect(held).toBeUndefined();
});

// The pick is what decides: carried, the same words resume the session, and the transcript says so.
test("words typed onto a hold picked to carry resume its session, saying what it re-reads", async () => {
    const { frames, sessions } = await continueOnto("carry");

    expect(frames).not.toContainEqual(expect.objectContaining({ kind: "agent_status", text: SUMMARIZING }));
    expect(frames.find((frame) => frame.kind === "handoff")).toMatchObject({ kind: "handoff", mode: "carry", tokens: 420_000 });
    expect(sessions).toEqual(["session"]);
});
