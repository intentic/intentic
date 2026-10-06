import { AgentAttentionSchema, type AgentSummary, AgentSummarySchema, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { startTurnRun } from "../../agent/run/turn/turn-runs.js";
import type { Services } from "../../composition.js";
import { cardDeps } from "../../conversations/actor/card-deps.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { parkedCards } from "../../conversations/actor/parked-cards.js";
import { clearTurnTaint, NO_TAINT, publishTurnTaint } from "../../guard/turn-taint.js";
import { createDomainEvents } from "../../seams/domain-events.js";
import { memoryFleet } from "../../testing.js";
import { createHeldCards } from "../../guard/held-cards.js";
import type { HostGuardDeps } from "../host-guard-deps.js";
import { DeviceToolCallSchema, judgeHostRestart, restartInCall } from "../host-restart-guard.js";

// An agent restarting the sandbox it and the rest of the fleet run in, through a device tool: the owner is asked on a
// card naming who it would stop, whenever someone else is mid-turn. The orchestrator's rebuild that cut four agents at
// once is the case this pins.

const MACHINE = "rog";
const CALLER = "conv-orchestrator";
const OTHER = "conv-ledgerly";
const IDLE = "conv-finished";
const REBUILD = { tool: "swap_sandbox", op: "rebuild", doing: "Rebuild" };
const ASKED = { machine: MACHINE, call: REBUILD, conversationId: CALLER };

const fleet = memoryFleet();
const cards = parkedCards(fleet.conversations);

// The board's rows for the three conversations; which of them is mid-turn is the actors' own reading, not this list's.
const summary = (id: string, title: string): AgentSummary =>
    AgentSummarySchema.parse({
        id,
        title,
        status: "idle",
        provider: "claude",
        harness: "native",
        updatedAt: 0,
        // Waiting on nobody, in every way the schema knows.
        attention: AgentAttentionSchema.parse(Object.fromEntries(AgentAttentionSchema.keyof().options.map((kind) => [kind, false]))),
    });

const services = unstubbed<Services>("services", {
    conversations: fleet.conversations,
    agents: unstubbed<Services["agents"]>("agents", {
        list: () => [summary(CALLER, "ORCHESTRATOR"), summary(OTHER, "LEDGERLY"), summary(IDLE, "Done already")],
    }),
    cards,
    events: createDomainEvents(() => {}),
    sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
        get: async () => ({ ...SandboxSettingsSchema.parse({}), autoResumeOnRestart }),
    }),
});

// What the gate takes from above the host layer, as app.ts fills it: the real cards and the published turn.
const guards: HostGuardDeps = {
    cards: cardDeps(services),
    // A restart card is not held for the turn's close: nothing here registers one.
    held: createHeldCards(async () => {}),
    turnRun: (conversationId) => turnRunOf(fleet.conversations, conversationId),
    // A restart is never put to the judge.
    judge: async () => {
        throw new Error("a restart is not judged");
    },
};
// The owner's "pick up again after a restart" switch, off as it ships.
let autoResumeOnRestart = false;

// Each conversation's turn, held open by the real pump until the test ends it; the caller's is attended.
const ends = new Map<string, () => void>();
const liveTurn = (conversationId: string): void => {
    const held = new Promise<void>((resolve) => ends.set(conversationId, resolve));
    startTurnRun(
        { conversations: fleet.conversations, events: createDomainEvents(() => {}) },
        async function* pump() {
            await held;
            yield { kind: "done" } as const;
        },
        { conversationId, prompt: "work" },
    );
};
const endTurn = async (conversationId: string): Promise<void> => {
    ends.get(conversationId)?.();
    await turnRunOf(fleet.conversations, conversationId)?.waitUntilFinished();
};

// The card the gate raised on the caller's turn, once it is up.
const cardUp = async (): Promise<{ readonly requestId: string; readonly title: string | undefined; readonly description: string | undefined }> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const card = turnRunOf(fleet.conversations, CALLER)
            ?.rows.map((row) => row.permission)
            .find((permission) => permission?.status === "pending");
        if (card !== undefined) {
            return { requestId: card.requestId, title: card.title, description: card.description };
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("the gate raised no card on the turn");
};

beforeEach(() => {
    liveTurn(CALLER);
    publishTurnTaint(CALLER, NO_TAINT);
});

afterEach(async () => {
    await endTurn(CALLER);
    await endTurn(OTHER);
    await endTurn(IDLE);
    clearTurnTaint(CALLER);
    autoResumeOnRestart = false;
});

describe("which calls restart this sandbox", () => {
    // As the bridge hands it over: a JSON-RPC message, parsed by the gate's own schema.
    const call = (name: string, args: Record<string, string | number>) =>
        DeviceToolCallSchema.parse({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });

    it("names the swaps, a restart or stop, and new resources applied now, on this sandbox's own slug", () => {
        expect(restartInCall(call("swap_sandbox", { op: "rebuild", slug: "work", hash: "abc" }), "work")).toEqual(REBUILD);
        expect(restartInCall(call("swap_sandbox", { op: "update", slug: "work" }), "work")).toEqual({
            tool: "swap_sandbox",
            op: "update",
            doing: "Update",
        });
        expect(restartInCall(call("manage_sandbox", { op: "stop", slug: "work" }), "work")).toEqual({
            tool: "manage_sandbox",
            op: "stop",
            doing: "Stop",
        });
        // Removing this sandbox stops every turn in it too.
        expect(restartInCall(call("remove_sandbox", { slug: "work" }), "work")).toEqual({ tool: "remove_sandbox", op: "remove", doing: "Remove" });
        expect(restartInCall(call("reshape_sandbox", { slug: "work", when: "now", cpus: 4 }), "work")).toEqual({
            tool: "reshape_sandbox",
            op: "now",
            doing: "Restart with new resources",
        });
    });

    it("reads no call it cannot parse: a notification carries no id to answer", () => {
        expect(DeviceToolCallSchema.safeParse({ jsonrpc: "2.0", method: "tools/call", params: { name: "swap_sandbox" } }).success).toBe(false);
    });

    it("leaves alone what stops no turn here: another sandbox, a download, a start, resources saved for later", () => {
        expect(restartInCall(call("swap_sandbox", { op: "rebuild", slug: "other" }), "work")).toBeUndefined();
        expect(restartInCall(call("swap_sandbox", { op: "prepare", slug: "work" }), "work")).toBeUndefined();
        expect(restartInCall(call("manage_sandbox", { op: "start", slug: "work" }), "work")).toBeUndefined();
        expect(restartInCall(call("reshape_sandbox", { slug: "work", when: "nextRestart" }), "work")).toBeUndefined();
        expect(restartInCall(call("run_command", { command: "ic sandbox rebuild work" }), "work")).toBeUndefined();
        // A bare dev run has no container name, so no slug of its own to protect.
        expect(restartInCall(call("swap_sandbox", { op: "rebuild", slug: "work" }), undefined)).toBeUndefined();
    });
});

describe("nobody else is working", () => {
    it("forwards the call: the caller alone is stopped, and it chose to be", async () => {
        expect(await judgeHostRestart(services, guards, ASKED)).toBeUndefined();
        expect(turnRunOf(fleet.conversations, CALLER)?.rows.filter((row) => row.permission !== undefined)).toEqual([]);
    });
});

describe("another agent is mid-turn", () => {
    beforeEach(() => liveTurn(OTHER));

    it("asks the owner on a card naming who it stops, and forwards the call once they allow it", async () => {
        const judged = judgeHostRestart(services, guards, ASKED);
        const card = await cardUp();
        expect(card.title).toBe("Rebuild this sandbox now?");
        expect(card.description).toBe(
            "It restarts the sandbox on rog, which stops the agent working in it now: LEDGERLY. Its work is kept, and it waits to be continued once the sandbox is back.",
        );
        expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await judged).toBeUndefined();
    });

    it("says the stopped agents pick up by themselves where the owner turned that on", async () => {
        autoResumeOnRestart = true;
        liveTurn(IDLE);
        const judged = judgeHostRestart(services, guards, ASKED);
        const card = await cardUp();
        expect(card.description).toBe(
            "It restarts the sandbox on rog, which stops the 2 agents working in it now: LEDGERLY, Done already. They pick up again by themselves once the sandbox is back.",
        );
        expect(cards.resolve({ kind: "permission", requestId: card.requestId, decision: "once" })).toBe("settled");
        expect(await judged).toBeUndefined();
    });

    it("hands the agent the owner's no, and tells it not to find another way", async () => {
        const judged = judgeHostRestart(services, guards, ASKED);
        expect(cards.resolve({ kind: "permission", requestId: (await cardUp()).requestId, decision: "deny" })).toBe("settled");
        expect(await judged).toEqual({
            refusal: "The owner declined: not now. Do not restart the sandbox another way; say what is left undone until it can be.",
        });
    });

    it("holds it without a card when nobody is in the turn to ask", async () => {
        clearTurnTaint(CALLER);
        expect(await judgeHostRestart(services, guards, ASKED)).toEqual({
            refusal:
                "Held for the owner: this would restart the sandbox you run in, which stops 1 other agent working now (LEDGERLY), and there is " +
                "nobody in this turn to ask. Do not retry it unasked: ask the owner in chat, or wait until they are idle.",
        });
    });

    it("answers before the agent's client gives up, and the same call again collects the owner's yes", async () => {
        expect(await judgeHostRestart(services, guards, ASKED, 20)).toEqual({
            refusal:
                'Still waiting for the owner: a card asks them to approve swap_sandbox rebuild on "rog", and nothing has run yet. Their answer is ' +
                "kept for this exact call: make it again with the same arguments to wait for it. Do not restart the sandbox another way.",
        });
        expect(cards.resolve({ kind: "permission", requestId: (await cardUp()).requestId, decision: "once" })).toBe("settled");
        expect(await judgeHostRestart(services, guards, ASKED, 20)).toBeUndefined();
    });
});
