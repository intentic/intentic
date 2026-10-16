import { IN_MEMORY } from "@intentic/base/sqlite";
import { pino } from "pino";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { ApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import type { AutomationApproval } from "@intentic/sandbox-contract/schemas/automations";
import type { TurnBreakPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { beginTurn } from "../conversations/actor/conversation-actors.testing.js";
import { fleetStoreOver, memoryFleet } from "../conversations/registry/agents-registry.testing.js";
import { noPresences } from "../conversations/land/landed-presence.testing.js";
import { memoryAutomationsStore } from "../automations/automations-slice.testing.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import { automationRecord } from "../harness/route-stores.testing.js";
import { opt } from "../opt.js";
import { openConversationsDb } from "../store/conversations-db.js";
import { createFleet } from "../conversations/registry/agents-registry.js";
import type { LandStandings } from "../conversations/land/standing.js";
import type { Services } from "../composition.js";
import { startIdleStop } from "../system/idle-stop.js";
import { nextPromisedWakeAt } from "./platform-presence.js";
import { nextPromisedWake, PROMISED_WAKES } from "./promised-wakes.js";
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
            approvals: { list: async () => ({ approvals: [] }) },
            heldWakes: { list: async () => [] },
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
            { connected: () => 0, terminalActivityAt: async () => 0, working: () => workingNow(services, "idle-stop").length, nextPromisedWakeAt: () => nextPromisedWakeAt(services) },
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

// Every moment the sandbox promised somebody is one list (promised-wakes.ts), read by idle-stop and by the automatic update.
// What each reader answers is pinned where its owner is (the scheduler's, the bookings', the executor's); what this pins is
// that the list holds all of them, and where the two questions differ.

// Read once: the approvals executor measures "due now" against the real clock, so every moment here sits ahead of it.
const NOW = Date.now();
const inMinutes = (minutes: number): number => NOW + minutes * 60_000;

const approved = (id: string, scheduledAt: number | undefined): ApprovalSummary => ({
    id,
    kind: "post",
    platform: "x",
    actsAs: "poster",
    content: "hello",
    status: "approved",
    ...opt("scheduledAt", scheduledAt),
});

// A sandbox that holds exactly these promises and has nothing running: no turn, no land, no watch.
const promising = (promises: {
    readonly automations?: readonly AutomationRecord[];
    readonly approvals?: readonly ApprovalSummary[];
    readonly holds?: readonly AutomationApproval[];
}): Services => {
    const { agents, conversations } = memoryFleet();
    return unstubbed<Services>("services", {
        agents,
        conversations,
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        automations: memoryAutomationsStore([...(promises.automations ?? [])]),
        heldWakes: unstubbed<Services["heldWakes"]>("heldWakes", { list: async () => [...(promises.holds ?? [])] }),
        approvals: unstubbed<Services["approvals"]>("approvals", { list: async () => ({ approvals: [...(promises.approvals ?? [])], invalid: [] }) }),
    });
};

const once = (id: string, at: number): AutomationRecord => automationRecord(id, { trigger: { kind: "once", at } });
// Daily at 03:00 in the sandbox's zone (UTC unless set): a moment this far from NOW is the cron's whichever clock reads it.
const nightly = (id: string): AutomationRecord => automationRecord(id, { trigger: { kind: "schedule", cron: "0 3 * * *" } });

describe("the one list of promised wakes", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it("names every clock that starts something on a moment somebody was promised, and which question each answers", () => {
        expect(PROMISED_WAKES.map(({ name, holds }) => [name, holds])).toEqual([
            ["a one-time automation", ["idle-stop", "restart"]],
            ["a scheduled message, or a held turn booked for its allowance's reset", ["idle-stop", "restart"]],
            ["an approved post or action", ["idle-stop", "restart"]],
            ["a held automation wake counting down", ["idle-stop", "restart"]],
            ["a cron automation", ["restart"]],
        ]);
    });

    it("promises nothing when nothing was promised", async () => {
        const services = promising({});
        expect(await nextPromisedWake(services, "idle-stop")).toBeUndefined();
        expect(await nextPromisedWake(services, "restart")).toBeUndefined();
        expect(await nextPromisedWakeAt(services)).toBe(0);
    });

    it("answers the soonest of what was promised, whichever clock keeps it", async () => {
        const services = promising({
            automations: [once("dentist", inMinutes(90))],
            approvals: [approved("post", inMinutes(20)), approved("later", inMinutes(40))],
        });
        expect(await nextPromisedWake(services, "idle-stop")).toBe(inMinutes(20));
        expect(await nextPromisedWake(services, "restart")).toBe(inMinutes(20));
        const reminder = promising({ automations: [once("dentist", inMinutes(5))], approvals: [approved("post", inMinutes(20))] });
        expect(await nextPromisedWake(reminder, "idle-stop")).toBe(inMinutes(5));
    });

    it("an approved item already due, or approved with no date, is due now", async () => {
        const services = promising({ approvals: [approved("late", NOW - 60_000), approved("undated", undefined)] });
        const at = await nextPromisedWake(services, "idle-stop");
        expect(at).toBeGreaterThanOrEqual(Date.now() - 1_000);
        expect(at).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    it("an item that is not approved promises nothing", async () => {
        const proposed: ApprovalSummary = { ...approved("idea", inMinutes(5)), status: "proposed" };
        expect(await nextPromisedWake(promising({ approvals: [proposed] }), "idle-stop")).toBeUndefined();
    });

    it("a held wake counting down is a moment the sandbox promised, and one waiting on a person is not", async () => {
        const counting: AutomationApproval = { id: "hold-1", automationId: "nightly", createdAt: NOW, autoRunAt: inMinutes(3) };
        const asking: AutomationApproval = { id: "hold-2", automationId: "nightly", createdAt: NOW };
        expect(await nextPromisedWake(promising({ holds: [asking, counting] }), "idle-stop")).toBe(inMinutes(3));
        expect(await nextPromisedWake(promising({ holds: [asking] }), "idle-stop")).toBeUndefined();
    });

    it("a cron holds the automatic update's restart and not idle-stop", async () => {
        const services = promising({ automations: [nightly("nightly")] });
        expect(await nextPromisedWake(services, "idle-stop")).toBeUndefined();
        const cronAt = await nextPromisedWake(services, "restart");
        expect(cronAt).toBeGreaterThan(Date.now());
        expect(cronAt).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
    });

    it("keeps an idle machine up through the moment an approved post is due, which only the executor's clock sends", async () => {
        jest.useFakeTimers();
        const dueAt = Date.now() + 8 * 60_000;
        const services = promising({ approvals: [approved("post", dueAt)] });
        // Nothing runs: the approved post is what holds the machine, not a turn.
        expect(workingNow(services, "idle-stop")).toEqual([]);

        const stop = jest.fn();
        const dispose = startIdleStop(
            { minutes: 5, logger },
            {
                connected: () => 0,
                terminalActivityAt: async () => 0,
                working: () => workingNow(services, "idle-stop").length,
                nextPromisedWakeAt: () => nextPromisedWakeAt(services),
            },
            stop,
        );
        for (let minute = 0; minute < 8; minute += 1) {
            await advanceTimersByTimeAsync(60_000);
        }
        expect(stop).not.toHaveBeenCalled();
        dispose();
    });

    it("stops an idle machine whose only approved post is due further out than one window", async () => {
        jest.useFakeTimers();
        const services = promising({ approvals: [approved("post", Date.now() + 6 * 3_600_000)] });

        // The watchdog stops with the machine it stops, so a stop is one call however long the suite waits after it.
        let dispose = (): void => {};
        const stop = jest.fn(() => dispose());
        dispose = startIdleStop(
            { minutes: 5, logger },
            {
                connected: () => 0,
                terminalActivityAt: async () => 0,
                working: () => workingNow(services, "idle-stop").length,
                nextPromisedWakeAt: () => nextPromisedWakeAt(services),
            },
            stop,
        );
        for (let minute = 0; minute < 7; minute += 1) {
            await advanceTimersByTimeAsync(60_000);
        }
        expect(stop).toHaveBeenCalledTimes(1);
        dispose();
    });
});
