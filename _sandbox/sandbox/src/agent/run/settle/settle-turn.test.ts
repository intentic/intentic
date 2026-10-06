import { STATE_DIR } from "@intentic/constants";
import type { TurnProof } from "@intentic/sandbox-contract";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { Services } from "../../../composition.js";
import { fakeHistory, recordingLogger } from "../../../harness/route-fakes.testing.js";
import { recordingTurnStores, services } from "../../../harness/route-services.testing.js";
import { beginTurn } from "../../../testing.js";
import { performSettlement } from "./settle-turn.js";
import type { SettlementPlan } from "./turn-settlement.js";

// The executor runs in one order, noted as it goes; the resume records and the proof are the conversation's events,
// noted as they are sent (`traced`).
const order: string[] = [];
// Each resume record's event, under the step it is in the running order.
const RESUME_STEPS: Readonly<Record<string, string>> = { "turn-held": "held", "turn-got-somewhere": "ladder" };

afterEach(() => {
    order.length = 0;
});

const input = { prompt: "go", conversationId: "settle-1" };
const noCode = { state: "no-code", paths: [], check: undefined } as const;

// The stores the executor writes, recording, each call also noted in the running order.
const traced = (): {
    readonly deps: Services;
    readonly writes: ReturnType<typeof recordingTurnStores>["writes"];
    readonly lines: Record<string, unknown>[];
} => {
    const { writes, overrides } = recordingTurnStores();
    const { lines, logger } = recordingLogger();
    const deps = services({ ...overrides, logger });
    return {
        deps: {
            ...deps,
            conversations: {
                ...deps.conversations,
                send: (id, event, now) => {
                    order.push(RESUME_STEPS[event.kind] ?? event.kind);
                    return deps.conversations.send(id, event, now);
                },
            },
            usage: {
                ...deps.usage,
                record: async (row) => {
                    order.push("usage");
                    await deps.usage.record(row);
                },
            },
            headroom: {
                ...deps.headroom,
                refresh: async (options) => {
                    order.push("refresh");
                    await deps.headroom.refresh(options);
                },
            },
            // The snapshot is history's reaction to the main tree changing, subscribed on the services themselves.
            events: {
                ...deps.events,
                publish: (name, event) => {
                    order.push(name === "tree.changed" ? "snapshot" : name);
                    deps.events.publish(name, event);
                },
            },
        },
        writes,
        lines,
    };
};

const turn = { record: () => void order.push("completion"), flush: () => void order.push("flush") };

const plan = (change: Partial<SettlementPlan> = {}): SettlementPlan => ({
    hold: undefined,
    completion: { type: "turn.completed" },
    headroomRefresh: undefined,
    usage: {
        provider: "claude",
        harness: "native",
        outcome: "ok",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: 0,
    },
    proof: undefined,
    reach: undefined,
    snapshot: undefined,
    ...change,
});

// What a turn that edited code and ran a failing suite showed of its own work.
const FAILING: TurnProof = { at: 1_000, verification: "failing", check: "pnpm test" };

describe("a settlement", () => {
    test("records the resume first, then notes the proof, closes the turn, re-reads, bills, flushes and snapshots", () => {
        const { deps, writes } = traced();
        performSettlement(
            deps,
            plan({
                hold: { kind: "held", held: { input, reason: "stopped", ran: true, standing: noCode } },
                headroomRefresh: { scope: { providers: ["codex"] }, maxAgeMs: 10_000 },
                proof: { conversationId: "settle-1", proof: FAILING },
                snapshot: "go",
            }),
            turn,
        );

        expect(order).toStrictEqual(["held", "proof-noted", "completion", "refresh", "usage", "flush", "snapshot"]);
        expect(deps.conversations.state("settle-1")?.resume.held).toMatchObject({ reason: "stopped", ran: true });
        // Kept on the turn until the settle files it: nothing runs a check or sends the turn back.
        expect(deps.conversations.state("settle-1")?.turn.proof).toStrictEqual(FAILING);
        expect(writes.headroomRefreshes).toStrictEqual([{ scope: { providers: ["codex"] }, maxAgeMs: 10_000 }]);
        expect(writes.snapshots).toStrictEqual([{ trigger: "turn", label: "go" }]);
    });

    test("hands the settle the proof it files on the card", async () => {
        const { deps } = traced();
        await beginTurn(
            deps.conversations,
            { conversationId: "settle-2", isolated: true, prompt: "go", profile: { agent: "codex" } },
            1_000,
        );
        performSettlement(deps, plan({ proof: { conversationId: "settle-2", proof: FAILING } }), turn);
        await deps.conversations.send("settle-2", { kind: "settle" }, 2_000).settled;

        expect(deps.agents.entry("settle-2")?.proof).toStrictEqual(FAILING);
        expect(deps.agents.get("settle-2")?.proof).toStrictEqual(FAILING);
        expect(deps.conversations.state("settle-2")?.turn.proof).toBeUndefined();
    });

    test("hands what the frames saw of where the work went to the turn's reach, for its close to finish", () => {
        const { deps } = traced();
        const handed: unknown[] = [];
        const framed = {
            live: [`${STATE_DIR}/local/state.json`],
            published: [{ remote: "origin", branch: "main", command: "git push origin main" }],
        };
        performSettlement(deps, plan({ reach: framed }), { ...turn, reach: (frames) => void handed.push(frames) });
        performSettlement(deps, plan(), { ...turn, reach: (frames) => void handed.push(frames) });
        expect(handed).toStrictEqual([framed]);
    });

    test("files the reach a turn noted, and the next turn's replaces it, cleared when it noted none", async () => {
        const { deps } = traced();
        const reach = { at: 1_500, live: [{ path: `${STATE_DIR}/local/extensions/intentic-x`, extension: "intentic.x" }] };
        const opening = { conversationId: "settle-3", isolated: true, prompt: "go", profile: { agent: "codex" as const } };
        await beginTurn(deps.conversations, opening, 1_000);
        await deps.conversations.send("settle-3", { kind: "reach-noted", reach }, 1_500).settled;
        await deps.conversations.send("settle-3", { kind: "settle" }, 2_000).settled;
        expect(deps.agents.entry("settle-3")?.reach).toStrictEqual(reach);
        expect(deps.agents.get("settle-3")?.reach).toStrictEqual(reach);
        expect(deps.conversations.state("settle-3")?.turn.reach).toBeUndefined();

        // A manual land settles with no turn under it, and leaves the last turn's reach standing.
        await deps.conversations.send("settle-3", { kind: "settle" }, 2_500).settled;
        expect(deps.agents.entry("settle-3")?.reach).toStrictEqual(reach);

        await beginTurn(deps.conversations, opening, 3_000);
        await deps.conversations.send("settle-3", { kind: "reach-noted", reach: undefined }, 3_500).settled;
        await deps.conversations.send("settle-3", { kind: "settle" }, 4_000).settled;
        expect(deps.agents.entry("settle-3")?.reach).toBeUndefined();
        expect(deps.agents.get("settle-3")?.reach).toBeUndefined();
    });

    test("of a run that got somewhere resets the ladder, and one with nothing to hold, prove or snapshot does only the rest", () => {
        const { deps, writes } = traced();
        performSettlement(deps, plan({ hold: { kind: "got-somewhere", conversationId: "settle-1" } }), turn);
        expect(order).toStrictEqual(["ladder", "completion", "usage", "flush"]);
        expect(writes.usage).toStrictEqual([plan().usage]);
        expect(writes.snapshots).toStrictEqual([]);
    });

    test("logs a ledger or snapshot write that fails under its own name, and never throws it", async () => {
        const rejecting = async (): Promise<never> => {
            throw new Error("disk full");
        };
        const { lines, logger } = recordingLogger();
        performSettlement(
            services({ logger, usage: { record: rejecting }, history: fakeHistory({ snapshot: rejecting }) }),
            plan({ snapshot: "go" }),
            turn,
        );
        await waitFor(
            () =>
                expect(lines.filter((line) => line["level"] === "warn").map((line) => line["message"])).toStrictEqual([
                    "usage: ledger append failed",
                    "history: turn snapshot failed",
                ]),
            SETTLES,
        );
    });
});
