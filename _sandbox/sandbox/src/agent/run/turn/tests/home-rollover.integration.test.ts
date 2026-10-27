import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import type { Services } from "../../../../composition.js";
import { HOME_WORK_NOTE_TITLE } from "../../../../conversations/home/home-rollover.js";
import { services as routeServices, recordingTurnStores } from "../../../../harness/route-services.testing.js";
import { collect } from "../../../../harness/route-client.testing.js";
import { streamAgent } from "../../stream-agent.js";

/* A home conversation is one chat kept for good. Past its budget its next turn goes on in a fresh session rather than
   re-reading the whole old one on every call (conversations/home/home-rollover.ts); under it, it resumes as any chat. */

const ROWS: TranscriptRow[] = [
    { role: "user", text: "Make the parser faster" },
    { role: "assistant", text: "Started a subagent on it; its tests pass and I merged it." },
];
const HOME = "home-test0rollover1";

const homeTurnAt = async (contextTokens: number, before?: (deps: Services) => Promise<void>) => {
    const recorded = recordingTurnStores();
    const sessions: (string | undefined)[] = [];
    const notes: string[] = [];
    const plain = routeServices({});
    const deps: Services = routeServices({
        ...recorded.overrides,
        transcripts: { ...plain.transcripts, read: async () => ROWS },
        async *agent(request): AsyncGenerator<AgentEvent> {
            sessions.push(request.spec.sessionId);
            notes.push(request.spec.prompt);
            yield { kind: "session", sessionId: request.spec.sessionId ?? "fresh" };
            yield { kind: "delta", text: "Done." };
            yield { kind: "usage", inputTokens: 10, outputTokens: 10, costUsd: 0, numTurns: 1, durationMs: 1 };
            yield { kind: "done" };
        },
    });
    const profile = { provider: "claude", harness: "native" } as const;
    await deps.conversations.send(HOME, { kind: "begin", turn: { conversationId: HOME, prompt: "Make the parser faster", isolated: false, profile, home: true } }, 1)
        .settled;
    deps.conversations.send(HOME, { kind: "frame", frame: { kind: "session", sessionId: "session" } }, 2);
    deps.conversations.send(HOME, { kind: "frame", frame: { kind: "context_usage", tokens: contextTokens, contextWindow: 1_000_000 } }, 3);
    await deps.conversations.send(HOME, { kind: "settle" }, 4).settled;
    await before?.(deps);

    const frames = await collect(streamAgent(deps, { conversationId: HOME, prompt: "And the lexer?", agent: "claude", sessionId: "session" }, undefined));
    return { frames, sessions, prompt: notes.at(-1) ?? "", deps };
};

test("a home past its budget opens a fresh session, says so, and carries its policy into it again", async () => {
    const { frames, sessions, prompt } = await homeTurnAt(180_000);

    expect(frames.find((frame) => frame.kind === "fresh_start")).toEqual({ kind: "fresh_start", why: "budget", from: 180_000, summarized: false });
    // No hand-off summary model is set here: it opens with the recent conversation and the work in hand alone.
    expect(frames.find((frame) => frame.kind === "handoff")).toBeUndefined();
    expect(sessions.at(-1)).toBeUndefined();
    // The policy rides again, since the fresh session's history holds none of it, and the recent conversation is there.
    expect(prompt).toContain("How this home conversation works");
    expect(prompt).toContain("Make the parser faster");
    // It started no subagents, so no list of them rides.
    expect(prompt).not.toContain(HOME_WORK_NOTE_TITLE);
});

test("a home under its budget resumes its session as any chat does", async () => {
    const { frames, sessions, prompt } = await homeTurnAt(40_000);

    expect(frames.find((frame) => frame.kind === "fresh_start")).toBeUndefined();
    expect(sessions).toEqual(["session"]);
    expect(prompt).not.toContain("How this home conversation works");
});

// Start fresh (agents.startFreshHome) leaves its ask on the entry; the next turn takes it once.
test("a person's Start fresh opens the next turn fresh whatever its size, and is taken once", async () => {
    const { frames, sessions, deps } = await homeTurnAt(20_000, async (home) => {
        await home.agents.setFreshPending(HOME, "asked");
    });

    expect(frames.find((frame) => frame.kind === "fresh_start")).toEqual({ kind: "fresh_start", why: "asked", summarized: false });
    expect(sessions.at(-1)).toBeUndefined();
    expect(deps.agents.entry(HOME)?.freshPending).toBeUndefined();
});
