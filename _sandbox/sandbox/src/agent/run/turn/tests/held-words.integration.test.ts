import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Services } from "../../../../composition.js";
import { collect } from "../../../../harness/route-client.testing.js";
import { recordingTurnStores, services } from "../../../../harness/route-services.testing.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { recordProviderSuccess } from "../../../providers/provider-health.js";
import type { TurnInput } from "../../../../seams/turn-starter.js";
import type { AgentRequest } from "../../../providers/agent-request.js";
import { streamAgent } from "../../stream-agent.js";

/* Gap 6, 2026-11-03: a person's turn a spent allowance refused before the model answered a word stays in the chat under
   its "Limit reached", held for Continue. Typed words instead took its place: the hold was superseded as they began, and
   the session they resumed had never read the refused words, so the model answered the new words alone while the chat
   showed both sent. Through the real stream (stream-agent.ts prepareTurn), what the model is asked each turn. */

afterEach(() => recordProviderSuccess("claude"));

const ADA = { actor: "ada@example.com", speaker: { kind: "person" as const, email: "ada@example.com" } };
const CONVERSATION = "held-words";
const REFUSED: readonly AgentEvent[] = [
    { kind: "session", sessionId: "s-1" },
    { kind: "error", code: "rate_limit", message: "Claude usage limit reached." },
    { kind: "done" },
];
const ANSWERED: readonly AgentEvent[] = [{ kind: "session", sessionId: "s-1" }, { kind: "delta", text: "On it." }, { kind: "done" }];

// One conversation's turns through the real stream, each answered by the next script, every request the runtime got kept.
const conversation = (scripts: readonly (readonly AgentEvent[])[]) => {
    const requests: AgentRequest[] = [];
    let turn = 0;
    const s: Services = services({
        ...recordingTurnStores().overrides,
        git: { sync: async () => ({ status: "current" }) },
        ...memoryFleet(),
        async *agent(request: AgentRequest): AsyncGenerator<AgentEvent> {
            requests.push(request);
            yield* scripts[turn++] ?? [{ kind: "done" }];
        },
    });
    const send = async (prompt: string, over: Partial<TurnInput> = {}): Promise<void> => {
        await collect(streamAgent(s, { prompt, conversationId: CONVERSATION, ...ADA, ...over }, undefined));
    };
    return { requests, send, held: () => s.conversations.state(CONVERSATION)?.resume.held };
};

test("words a spent allowance refused before the model answered go out ahead of the words typed after them", async () => {
    const chat = conversation([REFUSED, ANSWERED]);
    await chat.send("ship the parser");
    expect(chat.held()).toMatchObject({ reason: "limit", ran: false, input: { prompt: "ship the parser" } });

    await chat.send("and add a test for it", { sessionId: "s-1" });

    // On the session the refusal left, which never read them: the words it held, then the new ones.
    expect(chat.requests[1]?.spec).toMatchObject({ sessionId: "s-1", prompt: "ship the parser\n\nand add a test for it" });
    expect(chat.held()).toBeUndefined();
});

test("refused again, the hold keeps every word, so the press sends them all", async () => {
    const chat = conversation([REFUSED, REFUSED]);
    await chat.send("ship the parser");
    await chat.send("and add a test for it", { sessionId: "s-1" });

    expect(chat.held()).toMatchObject({ reason: "limit", ran: false, input: { prompt: "ship the parser\n\nand add a test for it" } });
});

test("words the model already answered to are not sent again with the next ones", async () => {
    const chat = conversation([
        [{ kind: "session", sessionId: "s-1" }, { kind: "delta", text: "Looking at the parser." }, ...REFUSED.slice(1)],
        ANSWERED,
    ]);
    await chat.send("ship the parser");
    expect(chat.held()).toMatchObject({ reason: "limit", ran: true });

    await chat.send("and add a test for it", { sessionId: "s-1" });

    expect(chat.requests[1]?.spec.prompt).toBe("and add a test for it");
});
