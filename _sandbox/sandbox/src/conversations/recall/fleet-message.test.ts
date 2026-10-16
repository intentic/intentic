import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import { conversationEntry } from "../registry/agents-store.testing.js";
import { memoryFleet } from "../registry/agents-registry.testing.js";
import { messageConversation, messageTaint } from "./fleet-message.js";

// What a message makes of the turn it lands in. A stranger's words taint it; the target's own family's words taint it
// only when they carry outside content from the sender's own turn, or come from a runtime nothing gates.

// A small workspace: one family (a root a person opened, its child, that child's child, and a sibling), and a second
// conversation of its own nobody spawned.
const entries = new Map(
    [
        conversationEntry({ id: "root", identity: { startedBy: "owner@example.com" } }),
        conversationEntry({ id: "child", identity: { startedBy: "agent:root" } }),
        conversationEntry({ id: "grandchild", identity: { startedBy: "agent:child" } }),
        conversationEntry({ id: "sibling", identity: { startedBy: "agent:root" } }),
        conversationEntry({ id: "blind", identity: { startedBy: "agent:root" }, profile: { provider: "pi", harness: "native" } }),
        conversationEntry({ id: "stranger", identity: { startedBy: "owner@example.com" } }),
    ].map((entry) => [entry.id, entry]),
);

// Each conversation's live taint, by id: none unless a test names one.
const taintOf = (tainted: ReadonlyMap<string, string> = new Map()) => ({
    entry: (id: string) => entries.get(id),
    taintOf: (id: string) => tainted.get(id),
});

test("its own family's clean words taint nothing, whichever way up the tree they travel", () => {
    expect(messageTaint(taintOf(), "child", "root")).toBeUndefined();
    expect(messageTaint(taintOf(), "grandchild", "root")).toBeUndefined();
    expect(messageTaint(taintOf(), "root", "child")).toBeUndefined();
    expect(messageTaint(taintOf(), "sibling", "child")).toBeUndefined();
});

test("a conversation outside the family is a stranger, however clean its own turn", () => {
    expect(messageTaint(taintOf(), "stranger", "root")).toBe("agent:stranger");
    expect(messageTaint(taintOf(), "child", "stranger")).toBe("agent:child");
});

test("a shell with no conversation stamp, or a sender the registry does not know, is a stranger", () => {
    expect(messageTaint(taintOf(), undefined, "root")).toBe("a message from an agent shell outside any conversation");
    expect(messageTaint(taintOf(), "gone", "root")).toBe("agent:gone");
});

test("a family member whose own turn read outside content passes it on, saying who relayed it", () => {
    expect(messageTaint(taintOf(new Map([["child", "a fetched page"]])), "child", "root")).toBe("a fetched page, relayed by `child`");
    expect(messageTaint(taintOf(new Map([["child", "agent:stranger"]])), "child", "root")).toBe(
        "a message from another conversation, `stranger`, relayed by `child`",
    );
});

// No loop ships without permission rules today (Pi gained its own), so the test stands one in for `blind`'s runtime.
test("a family member on a runtime with no permission rules of its own is never clean", () => {
    const ungated = { ...taintOf(), capabilities: (provider: string) => ({ rulebook: provider === "pi" ? "none" : "hooks" }) as const };
    expect(messageTaint(ungated, "blind", "root")).toBe("a message from `blind`, which runs on pi, a runtime with no permission rules of its own");
});

// Pi itself now passes every call through the daemon's hooks (agent-runtimes.ts PI `rulebook: "hooks"`), so on the real
// catalog a Pi family member's clean words are its family's, and what its own turn read still passes on.
test("a family member on Pi, whose every call the daemon's hooks gate, is as clean as any other", () => {
    expect(messageTaint(taintOf(), "blind", "root")).toBeUndefined();
    expect(messageTaint(taintOf(new Map([["blind", "a fetched page"]])), "blind", "root")).toBe("a fetched page, relayed by `blind`");
});

// A message that opens a turn on the target continues the target's own session, on the routing it runs on now: the
// session decision is the one every turn the daemon starts takes (routing.ts sessionFor).
test("a message that opens a turn on its target continues the target's session on the target's own provider", async () => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    await beginTurn(fleet.conversations, { conversationId: "target", isolated: false, prompt: "earlier", profile: { agent: "codex", harness: "native" } }, 1);
    fleet.conversations.send("target", { kind: "frame", frame: { kind: "session", sessionId: "sess-codex" } });
    await fleet.conversations.send("target", { kind: "settle" }, 2).settled;
    const started: TurnInput[] = [];
    const services = unstubbed<Services>("services", {
        agents: fleet.agents,
        conversations: fleet.conversations,
        turns: unstubbed<Services["turns"]>("turns", {
            steer: async () => false,
            start: async (turn: TurnInput) => {
                started.push(turn);
                return { id: "run-1", async *frames () {} };
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
    });

    expect(await messageConversation(services, "sender", "target", "ready when you are")).toMatchObject({ ok: true, to: "target", delivery: "turn" });
    expect(started.map((turn) => [turn.conversationId, turn.agent, turn.sessionId])).toEqual([["target", "codex", "sess-codex"]]);
});
