import { RESUME_NOTES } from "@intentic/sandbox-contract/events/resume";
import type { ResumeRouting } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import { beginTurn } from "../actor/conversation-actors.testing.js";
import { conversationEntry } from "../registry/agents-store.testing.js";
import { memoryFleet } from "../registry/agents-registry.testing.js";
import { pressRouting, resumeConversation } from "./fleet-resume.js";

// An agent pressing another conversation's Continue: the held turn runs again whole (on another model when named),
// an ended one carries on in its own session, and nothing is said in anyone's name.

const fleetWith = async (profile: { agent: string; model?: string; account?: string }) => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    await beginTurn(fleet.conversations, { conversationId: "target", isolated: false, prompt: "run the x-engage job", profile: { harness: "native", ...profile } }, 1);
    fleet.conversations.send("target", { kind: "frame", frame: { kind: "session", sessionId: "sess-1" } });
    await fleet.conversations.send("target", { kind: "settle" }, 2).settled;
    const started: TurnInput[] = [];
    const pressed: { readonly conversationId: string; readonly routing: ResumeRouting | undefined }[] = [];
    const services = unstubbed<Services>("services", {
        agents: fleet.agents,
        conversations: fleet.conversations,
        turns: unstubbed<Services["turns"]>("turns", {
            start: async (turn: TurnInput) => {
                started.push(turn);
                return { id: `run-${started.length}`, async *frames() {} };
            },
            // The held turn's own re-run (turn-resume.ts fireHeldResume), which keeps its prompt and note.
            resume: async (conversationId: string, routing?: ResumeRouting) => {
                pressed.push({ conversationId, routing });
                return { id: "run-held", async *frames() {} };
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
    });
    return { fleet, services, started, pressed };
};

test("a turn a spent allowance held runs again whole, moved to the provider and model the press names", async () => {
    const { fleet, services, started, pressed } = await fleetWith({ agent: "cursor", model: "claude-opus-4-8" });
    fleet.conversations.send("target", {
        kind: "turn-held",
        held: { input: { conversationId: "target", prompt: "run the x-engage job", agent: "cursor", harness: "native", model: "claude-opus-4-8" }, reason: "limit", ran: false },
    }, 3);

    const outcome = await resumeConversation(services, "presser", "target", { provider: "claude", model: "claude-opus-5-5", effort: "medium" });

    expect(outcome).toMatchObject({ ok: true, to: "target", run: "run-held", resumed: "held", on: { provider: "claude", model: "claude-opus-5-5" } });
    // The held request itself goes again, re-pointed: no new turn with words of the presser's.
    expect(pressed).toEqual([{ conversationId: "target", routing: { agent: "claude", harness: "native", model: "claude-opus-5-5", effort: "medium" } }]);
    expect(started).toEqual([]);
});

test("a conversation that simply ended carries on in its own session with the continued note and no words", async () => {
    const { services, started } = await fleetWith({ agent: "claude", model: "claude-sonnet-5-5" });

    expect(await resumeConversation(services, "presser", "target")).toMatchObject({ ok: true, resumed: "continued", on: { provider: "claude", model: "claude-sonnet-5-5" } });
    expect(started[0]).toMatchObject({ conversationId: "target", agent: "claude", prompt: RESUME_NOTES.continued, resume: "continued", sessionId: "sess-1" });
});

test("refuses what a press cannot reach: an unknown handle, the presser itself, a running turn", async () => {
    const { fleet, services, started } = await fleetWith({ agent: "claude" });
    expect(await resumeConversation(services, "presser", "nobody-by-that-name")).toMatchObject({ ok: false, status: 404 });
    expect(await resumeConversation(services, "target", "target")).toMatchObject({ ok: false, status: 400 });
    await beginTurn(fleet.conversations, { conversationId: "target", isolated: false, prompt: "again", profile: { agent: "claude", harness: "native" } }, 4);
    expect(await resumeConversation(services, "presser", "target")).toMatchObject({ ok: false, status: 409 });
    expect(started).toEqual([]);
});

test("a move to another provider drops the old one's account, loop and tier; a model swap drops only the tier", () => {
    const entry = conversationEntry({
        id: "c",
        profile: { provider: "cursor", harness: "native", model: "claude-opus-4-8", account: "cursor-acct", effort: "high" },
    });
    expect(pressRouting(entry, {})).toMatchObject({ agent: "cursor", model: "claude-opus-4-8", account: "cursor-acct", effort: "high" });
    const moved = pressRouting(entry, { provider: "claude", model: "claude-opus-5-5" });
    expect(moved).toMatchObject({ agent: "claude", model: "claude-opus-5-5" });
    expect(moved.account).toBeUndefined();
    expect(moved.effort).toBeUndefined();
    const swapped = pressRouting(entry, { model: "claude-opus-5-5" });
    expect(swapped).toMatchObject({ agent: "cursor", model: "claude-opus-5-5", account: "cursor-acct" });
    expect(swapped.effort).toBeUndefined();
});
