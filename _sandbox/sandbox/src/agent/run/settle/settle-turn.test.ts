import type { Rule } from "@intentic/sandbox-contract";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { hoisted, SETTLES, waitFor } from "@intentic/testing/bun";
import type { Services } from "../../../composition.js";
import { fakeHistory, recordingLogger } from "../../../harness/route-fakes.testing.js";
import { recordingTurnStores, services } from "../../../harness/route-services.testing.js";
import * as verifyNudge from "../../verification/verify-nudge.js";
import type { AgentRequest } from "../../providers/agent-request.js";
import { daemonStopFindings, performSettlement } from "./settle-turn.js";
import type { SettlementPlan } from "./turn-settlement.js";
import { parkedCards } from "../../../agents/actor/parked-cards.js";
import { memoryFleet } from "../../../testing.js";

// Where a turn here parks its cards: one fleet's actors.
const cards = parkedCards(memoryFleet().conversations);

// The nudge is a follow-up turn, so it is noted in one running order on its way through; the resume records are the
// conversation's events, noted as they are sent (`traced`).
const { order, nudged } = hoisted(() => ({ order: [] as string[], nudged: [] as Parameters<typeof verifyNudge.nudgeUnverifiedWork>[0][] }));
// Each resume record's event, under the step it is in the running order.
const RESUME_STEPS: Readonly<Record<string, string>> = { "auth-refused": "auth", "outage-stranded": "outage", "turn-held": "held", "turn-got-somewhere": "ladder" };
mock.module("../../verification/verify-nudge.js", () => ({
    ...verifyNudge,
    nudgeUnverifiedWork: async (nudge: Parameters<typeof verifyNudge.nudgeUnverifiedWork>[0]) => {
        order.push("nudge");
        nudged.push(nudge);
        return undefined;
    },
}));

afterEach(() => {
    order.length = 0;
    nudged.length = 0;
});

const request: AgentRequest = {
    spec: { prompt: "go", cwd: "/w" },
    policy: {},
    tools: {},
    credential: { kind: "container" },
    hooks: { cards },
    signal: new AbortController().signal,
};
const input = { prompt: "go", conversationId: "settle-1" };
const noCode = { state: "no-code", paths: [], check: undefined } as const;

// The stores the executor writes, recording, each call also noted in the running order.
const traced = (): { readonly deps: Services; readonly writes: ReturnType<typeof recordingTurnStores>["writes"]; readonly lines: Record<string, unknown>[] } => {
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
    authFailure: undefined,
    outageFailure: undefined,
    hold: undefined,
    completion: { type: "turn.completed" },
    headroomRefresh: undefined,
    usage: { provider: "claude", harness: "native", outcome: "ok", turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0 },
    daemonStop: { conversationId: undefined, findings: { conversationId: undefined, isolated: false, request, edited: [], cwd: "/w", isolation: undefined }, nudge: undefined },
    snapshot: undefined,
    ...change,
});

// A command rule standing at the turn's end, and a runner that fails it the way a red suite does.
const suite: Rule = {
    id: "suite",
    label: "Run the suite",
    moment: "turn.ending",
    action: { kind: "command", command: "pnpm test", timeoutMs: 900_000 },
    enabled: true,
};
const redSuite: AgentRequest = {
    ...request,
    policy: { ...request.policy, turnEndingRules: [suite] },
    hooks: { ...request.hooks, runRuleCommand: async () => ({ status: "failed", exitCode: 1, output: "1 failed" }) },
};
const finding =
    'Before finishing, "Run the suite" ran this and it exited 1:\n`pnpm test`\n1 failed\nRepair that before finishing, or say plainly why it cannot be repaired here.';

describe("a settlement", () => {
    test("records the resume first, then closes the turn, re-reads, bills, runs the Stop, nudges, flushes and snapshots", async () => {
        const { deps, writes } = traced();
        const stopped = { conversationId: "settle-1", isolated: true, request: redSuite, edited: ["/w/a.ts"], cwd: "/w", isolation: undefined };
        const nudge = { conversationId: "settle-1", profile: {}, rules: [suite], ledger: { edited: () => [], verdict: () => undefined, standing: () => noCode, noteEdit: () => {}, noteCommand: () => {} } };
        await performSettlement(
            deps,
            plan({
                authFailure: { input, account: "acct", refusedToken: "tok" },
                outageFailure: { input, provider: "claude" },
                hold: { kind: "held", held: { input, reason: "stopped", ran: true, standing: noCode } },
                headroomRefresh: { scope: { providers: ["codex"] }, maxAgeMs: 10_000 },
                daemonStop: { conversationId: "settle-1", findings: stopped, nudge },
                snapshot: "go",
            }),
            turn,
        );

        expect(order).toStrictEqual(["auth", "outage", "held", "completion", "refresh", "usage", "nudge", "flush", "snapshot"]);
        // The nudge reads what the Stop found, so it was awaited first.
        expect(nudged).toStrictEqual([{ ...nudge, findings: [finding] }]);
        expect(deps.conversations.state("settle-1")?.resume.held).toMatchObject({ reason: "stopped", ran: true });
        expect(deps.conversations.state("settle-1")?.resume.outage).toMatchObject({ provider: "claude" });
        expect(writes.headroomRefreshes).toStrictEqual([{ scope: { providers: ["codex"] }, maxAgeMs: 10_000 }]);
        expect(writes.snapshots).toStrictEqual([{ trigger: "turn", label: "go" }]);
    });

    test("of a run that got somewhere resets the ladder, and one with nothing to hold, snapshot or nudge does only the rest", async () => {
        const { deps, writes } = traced();
        await performSettlement(deps, plan({ hold: { kind: "got-somewhere", conversationId: "settle-1" } }), turn);
        expect(order).toStrictEqual(["ladder", "completion", "usage", "flush"]);
        expect(writes.usage).toStrictEqual([plan().usage]);
        expect(writes.snapshots).toStrictEqual([]);
    });

    test("logs a ledger or snapshot write that fails under its own name, and never throws it", async () => {
        const rejecting = async (): Promise<never> => {
            throw new Error("disk full");
        };
        const { lines, logger } = recordingLogger();
        await performSettlement(
            services({ logger, usage: { record: rejecting }, history: fakeHistory({ snapshot: rejecting }) }),
            plan({ snapshot: "go" }),
            turn,
        );
        await waitFor(() => expect(lines.filter((line) => line["level"] === "warn").map((line) => line["message"])).toStrictEqual(["usage: ledger append failed", "history: turn snapshot failed"]), SETTLES);
    });
});

describe("the daemon's Stop", () => {
    const stop = { conversationId: "settle-1", isolated: true, request: redSuite, edited: [], cwd: "/w", isolation: undefined };

    test("runs the command rules on a daemon-stopped isolated turn and words what they found", async () => {
        expect(await daemonStopFindings(services(), stop)).toStrictEqual([finding]);
    });

    test("finds nothing on the main tree, which is everyone's, or for nobody's turn", async () => {
        expect(await daemonStopFindings(services(), { ...stop, isolated: false })).toStrictEqual([]);
        expect(await daemonStopFindings(services(), { ...stop, conversationId: undefined })).toStrictEqual([]);
    });

    test("matches a rule narrowed by path against what the turn edited, workspace-relative, and what changed beside it", async () => {
        const narrowed: Rule = { ...suite, when: { paths: ["src/**"] } };
        const ran: string[][] = [];
        const probe = (changed: readonly string[]): AgentRequest => ({
            ...request,
            policy: { ...request.policy, turnEndingRules: [narrowed] },
            hooks: {
                ...request.hooks,
                changedPaths: async () => changed,
                runRuleCommand: async (command) => {
                    ran.push([command]);
                    return { status: "passed", output: "" };
                },
            },
        });
        await daemonStopFindings(services(), { ...stop, request: probe([]), edited: ["/w/src/a.ts"] });
        await daemonStopFindings(services(), { ...stop, request: probe(["src/changed.ts"]), edited: [] });
        await daemonStopFindings(services(), { ...stop, request: probe([]), edited: ["/w/docs/readme.md"] });
        expect(ran).toStrictEqual([["pnpm test"], ["pnpm test"]]);
    });

    test("that cannot run is logged and finds nothing", async () => {
        const { lines, logger } = recordingLogger();
        const broken: AgentRequest = {
            ...redSuite,
            hooks: {
                ...redSuite.hooks,
                runRuleCommand: async () => {
                    throw new Error("no shell");
                },
            },
        };
        expect(await daemonStopFindings({ logger }, { ...stop, request: broken })).toStrictEqual([]);
        expect(lines.map(({ level, message, conversationId }) => ({ level, message, conversationId }))).toStrictEqual([
            { level: "warn", message: "turn-ending checks: could not run after the turn", conversationId: "settle-1" },
        ]);
    });
});
