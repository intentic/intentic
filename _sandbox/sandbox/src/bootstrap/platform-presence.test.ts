import { IN_MEMORY } from "@intentic/base/sqlite";
import { pino } from "pino";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { TurnBreakPolicy } from "@intentic/sandbox-contract";
import { beginTurn, fleetStoreOver, noPresences } from "../testing.js";
import { openConversationsDb } from "../store/conversations-db.js";
import { createFleet } from "../conversations/registry/agents-registry.js";
import type { LandStandings } from "../conversations/land/standing.js";
import type { Services } from "../composition.js";
import { startIdleStop } from "../system/idle-stop.js";
import { nextPromisedWakeAt } from "./platform-presence.js";
import { workingNow } from "./working-now.js";

// A spent allowance's held turn booked to go again at its reset is a moment only this daemon's clock keeps, as a
// scheduled send or a one-time automation is: the idle-stop watchdog stays up for it rather than stopping minutes before
// and leaving the resend to whoever next visits.

const standings = (): LandStandings => ({ of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} });
const logger = pino({ level: "silent" });
const PROFILE = { agent: "claude", harness: "native" } as const;

// One conversation whose turn hit its allowance at `now`, held for the reset `reopensAt` (epoch s), under `limitPolicy`.
const heldUntil = async (now: number, reopensAt: number, limitPolicy: TurnBreakPolicy, move?: { readonly account: string; readonly carry: boolean }) => {
    const { agents, conversations } = createFleet(fleetStoreOver(openConversationsDb(IN_MEMORY)), standings(), noPresences());
    await agents.init();
    await beginTurn(conversations, { conversationId: "c1", isolated: true, prompt: "go", profile: PROFILE }, now);
    conversations.send("c1", {
        kind: "frame",
        frame: { kind: "error", code: "rate_limit", message: "spent", autoResume: "scheduled", resetsAt: reopensAt, held: { ran: true } },
    });
    const held = { input: { conversationId: "c1", prompt: "go" }, reason: "limit", ran: true, reopensAt, ...(move === undefined ? {} : { move }) } as const;
    conversations.send("c1", { kind: "turn-held", held }, now);
    await conversations.send("c1", { kind: "settle" }, now).settled;
    return {
        agents,
        conversations,
        services: {
            agents,
            conversations,
            sandboxSettings: { get: async () => ({ limitPolicy }) },
            automations: { list: async () => [] },
        } as unknown as Services,
    };
};

describe("the wake a booked spent-allowance resend promises", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it("keeps an idle machine up through the reset a held turn is booked for", async () => {
        jest.useFakeTimers();
        const now = Date.now();
        const reopensAt = Math.ceil((now + 8 * 60_000) / 1000);
        const { agents, services } = await heldUntil(now, reopensAt, "resend");
        expect(agents.get("c1")).toMatchObject({ limitHeld: true, limitScheduled: true });
        // Nothing runs: the wake is what holds the machine, not a turn.
        expect(workingNow(services, "idle-stop")).toEqual([]);
        expect(await nextPromisedWakeAt(services)).toBe(reopensAt * 1000);

        const stop = jest.fn();
        const dispose = startIdleStop(
            { minutes: 5, logger },
            { connected: () => 0, terminalActivityAt: async () => 0, working: () => workingNow(services, "idle-stop").length, nextOneTimeWakeAt: () => nextPromisedWakeAt(services) },
            stop,
        );
        for (let minute = 0; minute < 8; minute += 1) {
            await advanceTimersByTimeAsync(60_000);
        }
        expect(stop).not.toHaveBeenCalled();
        dispose();
    });

    it("promises no wake for a hold only a press sends, or one already fired", async () => {
        const now = Date.now();
        const reopensAt = Math.ceil((now + 8 * 60_000) / 1000);
        const waiting = await heldUntil(now, reopensAt, "wait");
        expect(await nextPromisedWakeAt(waiting.services)).toBe(0);

        const fired = await heldUntil(now, reopensAt, "resend");
        const judged = fired.conversations.state("c1")?.resume.held;
        if (judged === undefined) {
            throw new Error("expected a hold");
        }
        expect(fired.conversations.send("c1", { kind: "held-fired", ladder: false, judged }).reply).toBe(true);
        expect(await nextPromisedWakeAt(fired.services)).toBe(0);
    });

    it("a booked move goes at once while the answer is still to move, and waits for the reset once it is not", async () => {
        const now = Date.now();
        const reopensAt = Math.ceil((now + 8 * 60_000) / 1000);
        const moving = await heldUntil(now, reopensAt, "move", { account: "acct-b", carry: false });
        expect(await nextPromisedWakeAt(moving.services)).toBe(now);
        const resending = await heldUntil(now, reopensAt, "resend", { account: "acct-b", carry: false });
        expect(await nextPromisedWakeAt(resending.services)).toBe(reopensAt * 1000);
    });
});
