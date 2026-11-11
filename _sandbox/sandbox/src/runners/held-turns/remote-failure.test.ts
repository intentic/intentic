import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { lentToRunner } from "../ownership/account-holds.js";
import { remoteFailuresHere, unbooked } from "./remote-failure.js";

/* A runner's failed turn is carried on by the parent, never relayed as a promise the parent does not keep (2026-11-11). */

const turn = { conversationId: "c1", prompt: "fix the grapple", agent: "claude" as const, harness: "native" as const };

async function* frames(...events: AgentEvent[]): AsyncGenerator<AgentEvent> {
    yield* events;
}

const relayed = async (events: AgentEvent[], input: typeof turn & { resume?: "auth" } = turn) => {
    const sent: unknown[] = [];
    const out: AgentEvent[] = [];
    const deps = { conversations: { send: (_id: string, event: unknown) => sent.push(event) }, logger: { info: () => undefined } };
    // SAFETY: the relay only calls `send` and `logger.info`, both stubbed here; the actor's reply is never read.
    for await (const frame of remoteFailuresHere(deps as never, input, "omen", frames(...events))) {
        out.push(frame);
    }
    return { sent, out };
};

const refused: AgentEvent = {
    kind: "error",
    code: "claude-token-refused",
    account: "acct-1",
    message: "Failed to authenticate: OAuth token revoked.",
    autoResume: "scheduled",
};

test("a borrowed Claude token refused on the runner is held here for a re-mint, superseding the token lent there", async () => {
    lentToRunner("omen", "acct-1", "token-lent", () => () => undefined);
    const { sent, out } = await relayed([{ kind: "session", sessionId: "s1" }, { kind: "delta", text: "working" }, refused, { kind: "done" }]);
    expect(sent).toEqual([
        {
            kind: "turn-held",
            held: { input: turn, reason: "auth", ran: true, sessionId: "s1", remint: { account: "acct-1", refusedToken: "token-lent" } },
        },
    ]);
    expect(out.find((frame) => frame.kind === "error")).toMatchObject({ autoResume: "scheduled" });
});

test("the re-mint's own re-run refused again is not held again, and promises nothing", async () => {
    const { sent, out } = await relayed([refused], { ...turn, resume: "auth" });
    expect(sent).toEqual([]);
    expect(out[0]).toMatchObject({ autoResume: "available" });
});

test("a re-run the runner booked for itself is offered for a press here, never read as one coming", async () => {
    const stopped: AgentEvent = { kind: "error", message: "The CLI died.", autoResume: "scheduled", nextAt: 123 };
    const { sent, out } = await relayed([stopped]);
    expect(sent).toEqual([]);
    expect(out[0]).toEqual({ kind: "error", message: "The CLI died.", autoResume: "available" });
});

test("a frame that promised nothing passes through untouched", () => {
    const frame = { kind: "error" as const, message: "nope" };
    expect(unbooked(frame)).toBe(frame);
});
