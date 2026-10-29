import { attentionCards, laneOf } from "@intentic/sandbox-contract/models/agent-lanes";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { pino } from "pino";
import { childActor } from "../../../auth/principal.js";
import type { BeginTurn } from "../../../conversations/actor/conversation-decide.js";
import { beginTurn } from "../../../conversations/actor/conversation-actors.testing.js";
import { memoryFleet } from "../../../conversations/registry/agents-registry.testing.js";
import { createDomainEvents, type DomainEventMap } from "../../../seams/domain-events.js";
import type { TurnStarter } from "../../../seams/turn-starter.js";
import { startTurnRun } from "../../run/turn/turn-runs.js";
import { type ChildReportDeps, owedReports, reportChildTurn } from "../child-report.js";
import { resetSubagents } from "../subagents.js";

// A child's ending reaches the roster at its settle; the report it owes its parent starts the parent's turn only after the
// run has written its record, the report is composed and admitted, and the parent's own run has passed its preflight.
// Reproduced on 2026-10-29 with a real daemon: a parent idle beside a running child, the child failing, and ~100ms
// between the child's `error` and the parent's `running`, in which the board filed the child's stop as the reader's
// (a parent out of Active supervises nothing) and flew the family's card into Attention and back. Every roster the
// hand-off sends must keep the family out of Attention.

const logger = pino({ level: "silent" });

const turn = (over: Partial<BeginTurn>): BeginTurn => ({
    conversationId: "parent-1",
    isolated: true,
    prompt: "Split the parser into three children",
    profile: { agent: "claude", harness: "native" },
    ...over,
});

const settledOf = (over: Partial<DomainEventMap["run.settled"]> = {}): DomainEventMap["run.settled"] => ({
    conversationId: "sub-1",
    run: "run-1",
    actor: childActor("parent-1"),
    speaker: { kind: "agent", conversationId: "parent-1" },
    failure: "Provider refused.",
    closing: "",
    ...over,
});

const family = async () => {
    const fleet = memoryFleet();
    await fleet.agents.init();
    resetSubagents(fleet.conversations);
    const entries = new Map<string, { readonly startedBy?: string; readonly title?: string }>([
        ["parent-1", { title: "Split the parser" }],
        ["sub-1", { startedBy: childActor("parent-1"), title: "Port the tests" }],
    ]);
    // The parent's woken turn as the sandbox runs one: claimed at once, begun only after its preflight, which here is a
    // macrotask, and running until the suite lets it end.
    let finish: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const parentTurn: TurnStarter["stream"] = async function* () {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await beginTurn(fleet.conversations, turn({}), 3_000);
        await ended;
        await fleet.conversations.send("parent-1", { kind: "settle" }, 4_000).settled;
        yield { kind: "done" };
    };
    const deps: ChildReportDeps = {
        doors: {
            turns: {
                say: async (said) => {
                    const run = startTurnRun({ conversations: fleet.conversations, events: createDomainEvents(() => {}) }, parentTurn, said.turn);
                    return run === "busy" || run === "archived" ? { why: run } : { delivered: "started", run: run.id };
                },
            },
        },
        logger,
        conversations: fleet.conversations,
        entryOf: (conversationId) => entries.get(conversationId),
        profileOf: (conversationId) => (entries.has(conversationId) ? { agent: "claude", model: "opus" } : undefined),
        killNote: async () => undefined,
        landingOf: () => undefined,
    };
    // The parent spawned its child and ended its turn; the child is at work.
    await beginTurn(fleet.conversations, turn({}), 1_000);
    await fleet.conversations.send("parent-1", { kind: "settle" }, 1_100).settled;
    const owed = owedReports(deps);
    fleet.conversations.observe(owed.observer);
    await beginTurn(fleet.conversations, turn({ conversationId: "sub-1", startedBy: childActor("parent-1"), prompt: "Port the tests" }), 1_200);
    await fleet.conversations.send("sub-1", {
        kind: "journalled",
        run: "run-1",
        entry: { kind: "turn", turn: { conversationId: "sub-1", prompt: "Port the tests" }, startedAt: 1_200, attempts: 0 },
    }).settled;
    const frames: AgentSummary[][] = [];
    fleet.agents.subscribe((agents) => frames.push(agents));
    return { fleet, deps: { ...deps, owed }, frames, finish };
};

const statusOf = (frame: readonly AgentSummary[], id: string): string | undefined => frame.find((agent) => agent.id === id)?.status;

describe("a child's report on its way to an idle parent", () => {
    it("keeps the family out of Attention through every roster the hand-off sends, from the child's failure to the parent's turn", async () => {
        const { fleet, deps, frames, finish } = await family();

        await fleet.conversations.send("sub-1", { kind: "frame", frame: { kind: "error", message: "Provider refused." } }).settled;
        await fleet.conversations.send("sub-1", { kind: "settle" }, 2_000).settled;
        await reportChildTurn(deps, settledOf());
        // Any card's change goes out whole, so a roster can fall anywhere in the parent's preflight.
        await fleet.conversations.send("parent-1", { kind: "watches-shown", watches: [] }).settled;
        await new Promise((resolve) => setTimeout(resolve, 20));

        const sent = frames.slice(1);
        expect(sent.map((frame) => [statusOf(frame, "parent-1"), statusOf(frame, "sub-1")])).toContainEqual(["resuming", "error"]);
        expect(statusOf(sent.at(-1) ?? [], "parent-1")).toBe("running");
        expect(sent.map((frame) => attentionCards(frame))).toEqual(sent.map(() => 0));
        expect(sent.map((frame) => laneOf(frame.find((agent) => agent.id === "parent-1")!))).not.toContain("finished");
        finish();
    });

    it("gives the parent back its own ending, told again, when the report goes nowhere", async () => {
        const { fleet, deps, frames } = await family();

        await fleet.conversations.send("sub-1", { kind: "frame", frame: { kind: "error", message: "Provider refused." } }).settled;
        await fleet.conversations.send("sub-1", { kind: "settle" }, 2_000).settled;
        expect(statusOf(frames.at(-1) ?? [], "parent-1")).toBe("resuming");
        await reportChildTurn({ ...deps, doors: { turns: { say: async () => ({ why: "the parent is archived" }) } } }, settledOf());

        expect(statusOf(frames.at(-1) ?? [], "parent-1")).toBe("idle");
        // Nothing woke it, so the failure is the reader's again, through the parent's card.
        expect(attentionCards(frames.at(-1) ?? [])).toBe(1);
    });

    it("marks nothing for a turn a person ran in the child's own chat, which is never reported to the parent", async () => {
        const { fleet, deps, frames } = await family();
        // The parent's own turn on its child ended, and its report has gone.
        await fleet.conversations.send("sub-1", { kind: "settle" }, 1_500).settled;
        deps.owed.given("sub-1", "run-1");
        await beginTurn(fleet.conversations, turn({ conversationId: "sub-1", startedBy: "dev@example.com", prompt: "Try again" }), 1_600);
        await fleet.conversations.send("sub-1", {
            kind: "journalled",
            run: "run-2",
            entry: { kind: "turn", turn: { conversationId: "sub-1", prompt: "Try again" }, startedAt: 1_600, attempts: 0 },
        }).settled;

        await fleet.conversations.send("sub-1", { kind: "frame", frame: { kind: "error", message: "Provider refused." } }).settled;
        await fleet.conversations.send("sub-1", { kind: "settle" }, 2_000).settled;

        expect(statusOf(frames.at(-1) ?? [], "parent-1")).toBe("idle");
    });
});
