import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { ResumeRouting } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { WAIT_FOR_RESEND_MS, laterRungs, moveWakeOnward, movesOnward, wakeEnding, wakePostures } from "./wake-fallback.js";

// A wake nobody watches answers its own spent allowance: it goes again at a near reset, and moves onto the next open
// rung of its automation's ladder when no near reset answers.

const NOW = Date.UTC(2026, 9, 19, 19, 7);
const SONNET: ModelPin = { provider: "claude", model: "claude-sonnet-5-5" };
const OPUS_48: ModelPin = { provider: "cursor", model: "claude-opus-4-8" };
const SOL: ModelPin = { provider: "codex", model: "gpt-6.1-sol", effort: "medium" };
const CURSOR_OPUS: ModelPin = { provider: "cursor", model: "claude-opus-5-5" };
const LADDER = [SONNET, OPUS_48, SOL, CURSOR_OPUS];

test("a wake opens answering a spent allowance itself where the sandbox would wait for a press", () => {
    expect(wakePostures("wait")).toEqual({ limit: "resend", stopped: "retry" });
    // A sandbox already answering by itself is inherited as it stands.
    expect(wakePostures("move")).toEqual({ stopped: "retry" });
    expect(wakePostures("resend")).toEqual({ stopped: "retry" });
});

test("the ladder answers a spent allowance with no resend booked, or one booked far off, and nothing else", () => {
    expect(movesOnward({ code: "rate_limit" }, NOW)).toBe(true);
    expect(movesOnward({ code: "rate_limit", autoResume: "available" }, NOW)).toBe(true);
    expect(movesOnward({ code: "rate_limit", autoResume: "scheduled", nextAt: (NOW + 3 * 60_000) / 1000 }, NOW)).toBe(false);
    expect(movesOnward({ code: "rate_limit", autoResume: "scheduled", nextAt: (NOW + WAIT_FOR_RESEND_MS + 60_000) / 1000 }, NOW)).toBe(true);
    expect(movesOnward({ code: "agent-busy" }, NOW)).toBe(false);
    expect(movesOnward(undefined, NOW)).toBe(false);
});

test("only the rungs after the one that ran are candidates, in the ladder's order", () => {
    expect(laterRungs(LADDER, OPUS_48)).toEqual([SOL, CURSOR_OPUS]);
    expect(laterRungs(LADDER, CURSOR_OPUS)).toEqual([]);
    // A rung no longer on the ladder (the automation was edited since it fired) has nothing after it.
    expect(laterRungs(LADDER, { provider: "kimi", model: "kimi-k3" })).toEqual([]);
});

type Readiness = Awaited<ReturnType<Services["providerReadiness"]>>;
const NONE_READY: Readiness = { claude: false, codex: false, cursor: false, devin: false, gemini: false, grok: false, kimi: false, meta: false, zai: false };

const heldWake = async (ready: Partial<Readiness>) => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    fleet.conversations.send("wake", {
        kind: "turn-held",
        held: { input: { conversationId: "wake", prompt: "run the x-engage job", agent: "cursor", harness: "native", model: "claude-opus-4-8" }, reason: "limit", ran: false },
    }, 1);
    const pressed: ResumeRouting[] = [];
    const services = unstubbed<Services>("services", {
        conversations: fleet.conversations,
        providerReadiness: async (): Promise<Readiness> => ({ ...NONE_READY, ...ready }),
        usage: unstubbed<Services["usage"]>("usage", { turns: async () => [] }),
        providerModules: [],
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {} }),
        turns: unstubbed<Services["turns"]>("turns", {
            resume: async (_conversationId: string, routing?: ResumeRouting) => {
                if (routing !== undefined) {
                    pressed.push(routing);
                }
                return { id: "run-moved", async *frames() {} };
            },
        }),
    });
    return { services, pressed };
};

test("a refusal with no reset moves the held turn onto the next open rung, with that rung's own tier", async () => {
    // Codex is out, so the move steps over Sol to the rung after it.
    const { services, pressed } = await heldWake({ claude: true, cursor: true, codex: false });
    const moved = await moveWakeOnward(services, { conversationId: "wake", ladder: LADDER, ran: OPUS_48 }, { code: "rate_limit" }, NOW);
    expect(moved).toEqual({ rung: CURSOR_OPUS, run: "run-moved" });
    expect(pressed).toEqual([{ agent: "cursor", harness: "native", model: "claude-opus-5-5" }]);

    const { services: open, pressed: toSol } = await heldWake({ claude: true, cursor: true, codex: true });
    await moveWakeOnward(open, { conversationId: "wake", ladder: LADDER, ran: OPUS_48 }, { code: "rate_limit" }, NOW);
    expect(toSol).toEqual([{ agent: "codex", harness: "native", model: "gpt-6.1-sol", effort: "medium" }]);
});

test("a wake's ending names what happens next, and only a failure nothing carries on counts against it", async () => {
    const { services } = await heldWake({ claude: true, cursor: true, codex: true });
    const wake = { conversationId: "wake", ladder: LADDER, ran: OPUS_48 };
    expect(await wakeEnding(services, wake, undefined, undefined)).toEqual({ run: { outcome: "completed" }, failed: false });
    const moved = await wakeEnding(services, wake, "You're out of usage.", { code: "rate_limit" });
    expect(moved).toMatchObject({ failed: false, run: { outcome: "error", detail: "You're out of usage. Moved on to codex/gpt-6.1-sol (run run-moved)." } });
    // A reset a few minutes off is waited for: the run says when it goes again, and nothing moves.
    const nextAt = Math.floor(Date.now() / 1000) + 180;
    const booked = await wakeEnding(services, wake, "Out of allowance.", { code: "rate_limit", autoResume: "scheduled", nextAt });
    expect(booked).toEqual({ failed: false, run: { outcome: "error", detail: `Out of allowance. Goes again at ${new Date(nextAt * 1000).toISOString().slice(11, 16)} UTC.` } });
    expect(await wakeEnding(services, wake, "The provider crashed.", { code: "agent-busy" })).toEqual({ run: { outcome: "error", detail: "The provider crashed." }, failed: true });
});
