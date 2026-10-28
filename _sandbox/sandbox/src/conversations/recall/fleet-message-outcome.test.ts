import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { opt } from "../../opt.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { memoryStartWindow } from "../../store/start-window.testing.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import { type LiveRun, RUNS } from "../actor/conversation-holdings.js";
import { memoryFleet } from "../registry/agents-registry.testing.js";
import { messageConversation } from "./fleet-message.js";
import { peerOutcomePrompt, reportPeerMessageOutcome } from "./fleet-message-outcome.js";
import { messageDaemon } from "./fleet-message.testing.js";

// The sender of a message hears how the turn it opened went wrong, once: the 2026-10-28 sender was told a turn was
// starting, the provider refused it twice, and the sender told its user the turn had started.

const REFUSAL = "Your organization has disabled Claude subscription access for Claude Code";

// A sender, a target, and a third conversation the sender spawned; each idle, on Claude.
const workspace = async () => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    for (const [id, startedBy] of [["sender", undefined], ["target", undefined], ["child", "agent:sender"]] as const) {
        await beginTurn(fleet.conversations, { conversationId: id, isolated: false, prompt: "earlier", profile: { agent: "claude", harness: "native" }, ...opt("startedBy", startedBy) }, 1);
        await fleet.conversations.send(id, { kind: "settle" }, 2).settled;
    }
    return fleet;
};

const settledOf = (over: Partial<DomainEventMap["run.settled"]> = {}): DomainEventMap["run.settled"] => ({
    conversationId: "target",
    run: "run-1",
    actor: "agent:sender",
    speaker: undefined,
    failure: undefined,
    closing: "",
    ...over,
});

// A few turns of the event loop: what an announcement's listeners do after their first await.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("the sender of a message whose turn did not run", () => {
    test("is woken once, by the sandbox, with the provider's reason and what would let the turn go", async () => {
        const { services, started } = messageDaemon(await workspace());
        expect(await messageConversation(services, "sender", "target", "support replied", memoryStartWindow())).toMatchObject({ run: "run-1" });

        await reportPeerMessageOutcome(services, settledOf({ failure: REFUSAL }));
        expect(started.map((turn) => turn.conversationId)).toEqual(["target", "sender"]);
        const wake = started[1];
        expect(wake?.speaker).toEqual({ kind: "sandbox", source: "agents message" });
        expect(wake?.prompt).toContain("`target`");
        expect(wake?.prompt).toContain(REFUSAL);
        expect(wake?.prompt).toContain("Nothing sends it again by itself");
        expect(wake?.prompt).toContain("tell them it is not");

        // Once: the same ending heard again, and the re-run the sandbox sends of the same turn, wake nobody.
        await reportPeerMessageOutcome(services, settledOf({ failure: REFUSAL }));
        await reportPeerMessageOutcome(services, settledOf({ run: "run-3", failure: REFUSAL }));
        expect(started).toHaveLength(2);
    });

    test("hears what holds it when the turn waits for a press, and on which provider", async () => {
        const fleet = await workspace();
        const { services, started } = messageDaemon(fleet);
        await messageConversation(services, "sender", "target", "support replied", memoryStartWindow());
        fleet.conversations.send("target", { kind: "turn-held", held: { input: { conversationId: "target", prompt: "go", agent: "claude" }, reason: "door", ran: false, run: "run-1" } });

        await reportPeerMessageOutcome(services, settledOf({ failure: REFUSAL }));
        expect(started[1]?.prompt).toContain("`agents resume target` sends it again, and `--provider <id> --model <id>` moves it off claude");
    });

    test("hears that the sandbox tries a turn held by an outage again by itself, rather than being sent to press", async () => {
        const fleet = await workspace();
        const { services, started } = messageDaemon(fleet);
        await messageConversation(services, "sender", "target", "support replied", memoryStartWindow());
        fleet.conversations.send("target", { kind: "turn-held", held: { input: { conversationId: "target", prompt: "go", agent: "claude" }, reason: "outage", ran: true } });

        await reportPeerMessageOutcome(services, settledOf({ failure: "Overloaded" }));
        expect(started[1]?.prompt).toContain("the sandbox sends it again by itself once the provider answers again");
        expect(started[1]?.prompt).not.toContain("agents resume");
    });

    test("hears when the sandbox runs it again by itself", async () => {
        const { services, started } = messageDaemon(await workspace());
        await messageConversation(services, "sender", "target", "support replied", memoryStartWindow());
        const at = Date.UTC(2099, 0, 1, 15, 38) / 1000;
        await reportPeerMessageOutcome(services, settledOf({ failure: "usage limit reached", rerun: { at } }));
        expect(started[1]?.prompt).toContain("the sandbox sends it again by itself at 15:38 UTC");
    });

    test("is told of a queued message's turn once the queue let it go", async () => {
        const fleet = await workspace();
        fleet.conversations.send("target", {
            kind: "turn-held",
            held: { input: { conversationId: "target", prompt: "earlier", agent: "claude" }, reason: "limit", ran: true, reopensAt: Math.floor(Date.now() / 1000) + 3_600 },
        });
        const { services, started } = messageDaemon(fleet);
        const answer = await messageConversation(services, "sender", "target", "support replied", memoryStartWindow());
        const messageId = answer.ok ? answer.messageId : undefined;
        if (messageId === undefined) {
            throw new Error("a queued message answers with the id it waits under");
        }
        // A settle before it went is not its turn.
        await reportPeerMessageOutcome(services, settledOf({ run: "run-0", failure: REFUSAL }));
        expect(started).toEqual([]);
        // The queue let it go as run-9, the run whose first row carries it, and a person's words were said into it after.
        const rows = [
            { role: "user", text: "Message from another conversation", sentAt: 1, messageId, run: "run-9" },
            { role: "user", text: "and mine", sentAt: 2, messageId: "m-person", run: "run-9" },
        ] as const;
        fleet.conversations.holdings(RUNS).hold("target", "target", unstubbed<LiveRun>("run-9", { id: "run-9", done: true, ranNothing: true, rows, expired: () => false }));
        await reportPeerMessageOutcome(services, settledOf({ run: "run-9", failure: REFUSAL }));
        expect(started.map((turn) => turn.conversationId)).toEqual(["sender"]);
        expect(started[0]?.prompt).toStartWith(`Your message to \`target\` did not run: ${REFUSAL}`);
    });

    test("is not woken by a turn that simply finished, nor is a shell with no conversation, nor a parent its child reports to", async () => {
        const { services, started } = messageDaemon(await workspace());
        await messageConversation(services, "sender", "target", "ready", memoryStartWindow());
        await reportPeerMessageOutcome(services, settledOf({ closing: "Done." }));
        await messageConversation(services, undefined, "target", "ready", memoryStartWindow());
        await reportPeerMessageOutcome(services, settledOf({ run: "run-2", actor: "agent:(unstamped)", failure: REFUSAL }));
        // The child's own report to its parent says how its turn ended (child-report.ts).
        await messageConversation(services, "sender", "child", "ready", memoryStartWindow());
        await reportPeerMessageOutcome(services, settledOf({ conversationId: "child", run: "run-3", failure: REFUSAL }));
        expect(started.map((turn) => turn.conversationId)).toEqual(["target", "target", "child"]);
    });

    test("says a turn turned away at the door did not run, and one that failed partway failed", () => {
        const fields = { to: "deft-reef-zwn8", failure: `${REFUSAL}\nUse an API key instead.`, holding: "It is held." };
        expect(peerOutcomePrompt({ ...fields, ranNothing: true })).toStartWith(`Your message to \`deft-reef-zwn8\` did not run: ${REFUSAL} Use an API key instead.\n\nIt is held.`);
        expect(peerOutcomePrompt({ ...fields, ranNothing: false })).toStartWith("The turn your message opened on `deft-reef-zwn8` failed partway:");
    });
});

describe("agents message --wait", () => {
    test("answers how the turn ended with the head of its last reply, and the sender is not woken as well", async () => {
        const { services, started } = messageDaemon(await workspace());
        services.events.subscribe("run.settled", (settled) => reportPeerMessageOutcome(services, settled));
        const waiting = messageConversation(services, "sender", "target", "support replied", memoryStartWindow(), { timeoutMs: 5_000 });
        await waitFor(() => expect(started).toHaveLength(1));
        await settle();

        services.events.publish("run.settled", settledOf({ failure: REFUSAL, closing: `${"a".repeat(1_500)}TAIL` }));
        const answer = await waiting;
        expect(answer).toMatchObject({
            ok: true,
            delivery: "turn",
            waited: { outcome: "ended", ending: { run: "run-1", ended: "failed", failure: REFUSAL, reply: "a".repeat(1_500), replyCut: 4 } },
        });
        const ending = answer.ok && answer.waited?.outcome === "ended" ? answer.waited.ending : undefined;
        expect(ending?.holding).toContain("Nothing sends it again by itself");
        await settle();
        expect(started).toHaveLength(1);
    });

    test("answers a turn that finished with its reply", async () => {
        const { services, started } = messageDaemon(await workspace());
        const waiting = messageConversation(services, "sender", "target", "what is p99?", memoryStartWindow(), { timeoutMs: 5_000 });
        await waitFor(() => expect(started).toHaveLength(1));
        services.events.publish("run.settled", settledOf({ run: "run-0", closing: "an earlier turn" }));
        services.events.publish("run.settled", settledOf({ closing: "p99 is 210ms." }));
        expect(await waiting).toMatchObject({ waited: { outcome: "ended", ending: { run: "run-1", ended: "finished", reply: "p99 is 210ms." } } });
    });

    test("that gives up first hands an ending still to come back to the sender's wake", async () => {
        const { services, started } = messageDaemon(await workspace());
        services.events.subscribe("run.settled", (settled) => reportPeerMessageOutcome(services, settled));
        expect(await messageConversation(services, "sender", "target", "support replied", memoryStartWindow(), { timeoutMs: 20 })).toMatchObject({
            waited: { outcome: "timeout" },
        });
        services.events.publish("run.settled", settledOf({ failure: REFUSAL }));
        await waitFor(() => expect(started.map((turn) => turn.conversationId)).toEqual(["target", "sender"]));
    });
});
