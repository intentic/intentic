import { memoryStartWindow } from "../../store/start-window.testing.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import { parkedCards } from "../actor/parked-cards.js";
import { conversationEntry } from "../registry/agents-store.testing.js";
import { memoryFleet } from "../registry/agents-registry.testing.js";
import { messageConversation, messageTaint } from "./fleet-message.js";
import { messageDaemon } from "./fleet-message.testing.js";

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
    const { services, started } = messageDaemon(fleet);

    expect(await messageConversation(services, "sender", "target", "ready when you are", memoryStartWindow())).toMatchObject({ ok: true, to: "target", delivery: "turn" });
    expect(started.map((turn) => [turn.conversationId, turn.agent, turn.sessionId])).toEqual([["target", "codex", "sess-codex"]]);
});

// The remembered account is the planner's to fill in, never the message's to name: a named account is never moved off,
// so a peer's message to a conversation whose account its organisation had switched off went there anyway and was
// refused, twice, on 2026-10-28 (agents-store.ts conversationProfile).
test("a message names no account, so the planner can move the target off one that cannot serve", async () => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    await beginTurn(fleet.conversations, { conversationId: "target", isolated: false, prompt: "earlier", profile: { agent: "claude", harness: "native", account: "work" } }, 1);
    fleet.conversations.send("target", { kind: "frame", frame: { kind: "session", sessionId: "sess-work", account: "work" } });
    await fleet.conversations.send("target", { kind: "settle" }, 2).settled;
    expect(fleet.agents.entry("target")?.profile.account).toBe("work");
    const { services, started } = messageDaemon(fleet);

    expect(await messageConversation(services, "sender", "target", "support replied", memoryStartWindow())).toMatchObject({ ok: true, delivery: "turn" });
    expect(started).toHaveLength(1);
    expect(started[0]?.account).toBeUndefined();
    // Its own session still, since the routing it continues on is the conversation's own.
    expect(started[0]?.sessionId).toBe("sess-work");
});

// What the sender is told is what the door knows, never a hope: on 2026-10-28 "a turn on it is starting" was told of a
// turn the provider then refused twice, and the sender told its user the turn had started.
describe("the answer a message gets", () => {
    const idleTarget = async () => {
        const fleet = memoryFleet();
        await fleet.agents.init();
        await beginTurn(fleet.conversations, { conversationId: "target", isolated: false, prompt: "earlier", profile: { agent: "claude", harness: "native" } }, 1);
        await fleet.conversations.send("target", { kind: "settle" }, 2).settled;
        return fleet;
    };

    test("a turn it opens is said as opened and not yet answered, with its run, and never as starting or running", async () => {
        const { services } = messageDaemon(await idleTarget());
        const answer = await messageConversation(services, "sender", "target", "support replied", memoryStartWindow());
        expect(answer).toMatchObject({ ok: true, to: "target", delivery: "turn", run: "run-1" });
        const note = answer.ok ? answer.note : "";
        expect(note).toStartWith("Opened a turn on it (run run-1), which has not answered yet: the provider can still refuse it");
        expect(note).toContain("this conversation is told why, once");
        expect(note).not.toMatch(/starting|running/u);
    });

    test("a shell with no conversation is told nothing comes back of it, and where to look", async () => {
        const { services } = messageDaemon(await idleTarget());
        const answer = await messageConversation(services, undefined, "target", "hello", memoryStartWindow());
        expect(answer.ok ? answer.note : "").toContain("nothing comes back of it: `agents show target` says how it went");
    });

    test("words said into the live turn are said as steered, at no cost to the hourly budget", async () => {
        const fleet = await idleTarget();
        const steers: string[] = [];
        const { services, started } = messageDaemon(fleet);
        const steer = async (_id: string, words: { readonly text: string }): Promise<boolean> => {
            steers.push(words.text);
            return true;
        };
        const steering = { ...services, turns: { ...services.turns, steer } };
        const empty = { spend: async () => false };
        const answer = await messageConversation(steering, "sender", "target", "the lockfile is mine", empty);
        expect(answer).toMatchObject({ ok: true, delivery: "steered" });
        expect(answer.ok ? answer.note : "").toStartWith("Steered: said into its live turn");
        expect(steers).toHaveLength(1);
        expect(started).toEqual([]);
    });

    // A spent allowance whose window is known shut refuses any turn at the door within seconds: the message waits for
    // the reopen instead of opening a turn that cannot run, and says so.
    test("a target held behind a spent allowance queues the message and says what it waits for", async () => {
        const fleet = await idleTarget();
        const reopensAt = Math.floor(Date.now() / 1000) + 3_600;
        fleet.conversations.send("target", { kind: "turn-held", held: { input: { conversationId: "target", prompt: "earlier", agent: "claude" }, reason: "limit", ran: true, reopensAt } });
        const { services, started } = messageDaemon(fleet);
        const answer = await messageConversation(services, "sender", "target", "support replied", memoryStartWindow());
        expect(answer).toMatchObject({ ok: true, delivery: "queued", messageId: expect.any(String) });
        expect(answer.ok ? answer.note : "").toStartWith("Queued there, not delivered yet: behind the claude limit until");
        expect(started).toEqual([]);
        expect(fleet.conversations.queued("target").items.map((item) => [item.voice, item.actor])).toEqual([["agent", "agent:sender"]]);
    });

    // Refused with a 409 to try again later until 2026-10-28, with nothing to say when later was.
    test("a target whose turn in flight takes no words queues the message behind that turn, instead of refusing it", async () => {
        const fleet = memoryFleet();
        await fleet.agents.init();
        await beginTurn(fleet.conversations, { conversationId: "target", isolated: false, prompt: "earlier", profile: { agent: "claude", harness: "native" } }, 1);
        const asking = new AbortController();
        const card = parkedCards(fleet.conversations).create("question", { kind: "question", requestId: "", cancelled: true }, "target");
        void card.wait(asking.signal);
        const { services, started } = messageDaemon(fleet);
        const answer = await messageConversation(services, "sender", "target", "support replied", memoryStartWindow());
        asking.abort();
        expect(answer).toMatchObject({ ok: true, delivery: "queued" });
        expect(answer.ok ? answer.note : "").toStartWith("Queued there, not delivered yet: its running turn takes no words now");
        expect(started).toEqual([]);
    });

    test("an archived target is refused before anything is spent", async () => {
        const fleet = await idleTarget();
        await fleet.agents.setArchived(["target"], Date.now());
        const { services, started } = messageDaemon(fleet);
        expect(await messageConversation(services, "sender", "target", "hello", memoryStartWindow())).toMatchObject({ ok: false, status: 409 });
        expect(started).toEqual([]);
    });
});
