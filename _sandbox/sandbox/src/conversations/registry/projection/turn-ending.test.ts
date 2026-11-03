import { beginTurn } from "../../actor/conversation-actors.testing.js";
import { memoryFleet } from "../agents-registry.testing.js";
import { endingOf } from "./turn-ending.js";

// How a conversation's last turn ended, as its record offers to move it on. A turn that stopped with nothing to repair
// is the `carry` course of the contract's failure table (failure-codes.ts): a death nothing coded, and since 2026-11 a
// turn that reached its own iteration or time ceiling or ended incomplete, which no window used to offer to carry on.

const PROFILE = { agent: "claude", harness: "native" } as const;
const input = { conversationId: "c1", prompt: "Fix the parser", ...PROFILE };

// A fleet whose one conversation's turn ended on `code`, held as the classification holds it (or not at all).
const endedOn = async (code: "turn-cap" | "harness-incomplete" | "agent-busy" | undefined, pressOnly: boolean, held: boolean) => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, 1_000);
    fleet.conversations.send("c1", {
        kind: "frame",
        frame: { kind: "error", code, message: "Stopped short.", autoResume: "available", held: { ran: true } },
    });
    if (held) {
        const hold = { input, reason: "stopped", ran: true, contextTokens: 9_000 } as const;
        fleet.conversations.send("c1", { kind: "turn-held", held: pressOnly ? { ...hold, pressOnly: true } : hold }, 1_500);
    }
    await fleet.conversations.send("c1", { kind: "settle" }, 2_000).settled;
    return fleet;
};

describe("a turn that stopped with nothing to repair", () => {
    // Held for a press alone (held-turn.ts pressOnly), which the ending says, so no window asks a question whose answer
    // nothing would act on.
    test.each(["turn-cap", "harness-incomplete"] as const)("ends %s as stopped, with the turn it holds for the press alone", async (code) => {
        const fleet = await endedOn(code, true, true);
        expect(fleet.agents.get("c1")).toMatchObject({ status: "error", failureCode: code });
        expect(endingOf(fleet, "c1")).toEqual({ reason: "stopped", held: { ran: true, contextTokens: 9_000, pressOnly: true } });
    });

    test("ends a death nothing coded as stopped, as it always did", async () => {
        const fleet = await endedOn(undefined, false, true);
        expect(endingOf(fleet, "c1")).toEqual({ reason: "stopped", held: { ran: true, contextTokens: 9_000 } });
    });

    test("offers nothing for a code naming something to repair first", async () => {
        const fleet = await endedOn("agent-busy", false, false);
        expect(fleet.agents.get("c1")).toMatchObject({ status: "error", failureCode: "agent-busy" });
        expect(endingOf(fleet, "c1")).toBeUndefined();
    });

    // A stop held for a press alone climbs no ladder, so the rungs an earlier stop of the conversation climbed are not
    // said of it.
    test("says no rungs of a stop held for a press alone, whatever an earlier stop climbed", async () => {
        const fleet = memoryFleet();
        await fleet.agents.init();
        await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, 1_000);
        fleet.conversations.send("c1", {
            kind: "frame",
            frame: { kind: "error", message: "the harness crashed", autoResume: "scheduled", held: { ran: true } },
        });
        fleet.conversations.send("c1", { kind: "turn-held", held: { input, reason: "stopped", ran: true } }, 1_500);
        await fleet.conversations.send("c1", { kind: "settle" }, 2_000).settled;
        const judged = fleet.conversations.state("c1")?.resume.held;
        if (judged === undefined) {
            throw new Error("expected a hold");
        }
        expect(fleet.conversations.send("c1", { kind: "held-fired", ladder: true, judged }).reply).toBe(true);

        await beginTurn(fleet.conversations, { conversationId: "c1", isolated: true, prompt: "Fix the parser", profile: PROFILE }, 10_000);
        fleet.conversations.send("c1", {
            kind: "frame",
            frame: { kind: "error", code: "turn-cap", message: "Reached the maximum number of turns.", autoResume: "available", held: { ran: true } },
        });
        fleet.conversations.send("c1", { kind: "turn-held", held: { input, reason: "stopped", ran: true, pressOnly: true } }, 10_500);
        await fleet.conversations.send("c1", { kind: "settle" }, 11_000).settled;
        expect(fleet.conversations.state("c1")?.resume.held).toMatchObject({ pressOnly: true, tries: 1 });
        expect(endingOf(fleet, "c1")).toEqual({ reason: "stopped", held: { ran: true, pressOnly: true } });
    });
});
