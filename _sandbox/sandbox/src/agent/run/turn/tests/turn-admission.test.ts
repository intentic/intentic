import { ATTACHMENT_LIMIT, AgentTurnSchema, type AgentDomainPolicy, type AgentEvent, type TranscriptRow } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import type { Services } from "../../../../composition.js";
import type { ConversationEvent } from "../../../../conversations/actor/conversation-decide.js";
import { type LiveRun, turnRunOf } from "../../../../conversations/actor/conversation-holdings.js";
import type { QueuedItem } from "../../../../conversations/actor/conversation-queue.js";
import { createDomainEvents } from "../../../../seams/domain-events.js";
import { transcriptPageOf } from "../../../../sessions/agent-transcript.js";
import { beginTurn, notedFleet } from "../../../../testing.js";
import { AGENT_DOMAIN_NOT_READY } from "../../../../workload/domain/agent-domain-rollout.js";
import { createAgentExecutionService } from "../../../../workload/agent-execution.js";
import { streamAgent } from "../../stream-agent.js";
import { receiptOf } from "../message-receipts.js";
import { together } from "../turn-admission.js";
import { turnDoors } from "../turn-doors.js";

// Which waiting messages leave as one turn. A turn carries one sender's attribution, ownership and fence, so a batch
// must never join two senders' words, however they were queued.

const item = (id: string, voice: QueuedItem["voice"], actor?: string): QueuedItem => ({
    id,
    voice,
    ...(actor === undefined ? {} : { actor }),
    queuedAt: 0,
    revision: 1,
    turn: { prompt: id, conversationId: "c1", messageId: id },
});

test("one person's messages in a row leave together, and a second person's wait for their own turn", () => {
    const queue = [item("a1", "person", "alice"), item("a2", "person", "alice"), item("b1", "person", "bob"), item("a3", "person", "alice")];
    expect(together(queue).map((waiting) => waiting.id)).toEqual(["a1", "a2"]);
    expect(together(queue.slice(2)).map((waiting) => waiting.id)).toEqual(["b1"]);
});

// A turn the admission builds is one the sandbox can keep: a spent allowance's hold is written under AgentTurnSchema
// (limit-hold.ts), which caps the files a turn carries, so a batch never joins more than that. The message that would go
// past it waits for the next turn, its files with it, rather than any file being dropped.
test("a person's messages leave together only while their files fit one turn, and the rest go next with every file", () => {
    const withFiles = (id: string, count: number): QueuedItem => {
        const base = item(id, "person", "alice");
        return { ...base, turn: { ...base.turn, attachments: Array.from({ length: count }, (_, index) => `${id}/f${String(index)}.png`) } };
    };
    const queue = [withFiles("a1", 11), withFiles("a2", 11), withFiles("a3", 9)];
    expect(together(queue).map((waiting) => waiting.id)).toEqual(["a1"]);
    expect(together(queue.slice(1)).map((waiting) => waiting.id)).toEqual(["a2", "a3"]);
    expect(together([withFiles("a1", 10), withFiles("a2", 10)]).map((waiting) => waiting.id)).toEqual(["a1", "a2"]);
    // Words with no files still join a full turn; one more file does not.
    expect(together([withFiles("a1", ATTACHMENT_LIMIT), item("a2", "person", "alice"), withFiles("a3", 1)]).map((waiting) => waiting.id)).toEqual(["a1", "a2"]);
    for (const batch of [queue.slice(0, 1), queue.slice(1)]) {
        const files = batch.flatMap((waiting) => waiting.turn.attachments ?? []);
        expect(AgentTurnSchema.safeParse({ prompt: "joined", attachments: files }).success).toBe(true);
    }
});

test("the sandbox's own words leave alone, and a person's stop short of them", () => {
    expect(together([item("w1", "sandbox"), item("a1", "person", "alice")]).map((waiting) => waiting.id)).toEqual(["w1"]);
    expect(together([item("a1", "person", "alice"), item("w1", "sandbox")]).map((waiting) => waiting.id)).toEqual(["a1"]);
});

const domainRefusals = [
    ["unprivileged", async (): Promise<AgentDomainPolicy> => ({ agentDomain: "unprivileged" }), AGENT_DOMAIN_NOT_READY],
    ["unreadable protected", async (): Promise<AgentDomainPolicy> => { throw new Error("protected policy is unreadable"); }, "protected policy is unreadable"],
] as const;

// Real admission, detached start, fold and queue actors over the in-memory SQL store. Only the policy read waits:
// the test can observe the admitted batch while in flight without ever reaching a runtime, provider or filesystem.
const refusedAdmission = async (get: () => Promise<AgentDomainPolicy>) => {
    const sent: ConversationEvent[] = [];
    const fleet = notedFleet((_id, event) => void sent.push(event));
    await beginTurn(fleet.conversations, { conversationId: "c1", isolated: false, prompt: "earlier", profile: {} }, 1);
    await fleet.conversations.send("c1", { kind: "settle" }, 2).settled;
    sent.length = 0;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => { release = resolve; });
    const policyRead = jest.fn(async () => { await reading; return get(); });
    const rows: TranscriptRow[] = [];
    const append = jest.fn<Services["transcripts"]["append"]>(async (_agent, added) => { rows.push(...added); });
    const events = createDomainEvents(() => {});
    const settled = new Promise<void>((resolve) => { events.subscribe("run.settled", () => resolve()); });
    const services = unstubbed<Services>("services", {
        agents: fleet.agents,
        conversations: fleet.conversations,
        events,
        workspace: unstubbed<Services["workspace"]>("workspace", { root: "/nowhere/domain-admission" }),
        agentDomainPolicy: unstubbed<Services["agentDomainPolicy"]>("agentDomainPolicy", { get: policyRead }),
        // The daemon's own issuer over the same protected read, as composition.ts builds it.
        agentExecution: createAgentExecutionService(policyRead),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            page: (_agent, window) => transcriptPageOf(rows, window),
            count: async () => rows.length,
            append,
        }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
    });
    const turns = turnDoors(() => services, (input, signal) => streamAgent(services, input, signal));
    const currentRun = (): LiveRun => {
        const run = turnRunOf(fleet.conversations, "c1");
        if (run === undefined) { throw new Error("admission did not start a run"); }
        return run;
    };
    return { fleet, services, turns, currentRun, release, settled, policyRead, append, rows, sent };
};

const framesOf = async (run: LiveRun): Promise<AgentEvent[]> => {
    const frames: AgentEvent[] = [];
    for await (const frame of run.frames()) { frames.push(frame); }
    return frames;
};

const UNCHANGED_TOTALS = { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 1, toolUses: 0, subagents: 0 };

test.each(domainRefusals)("a queued person's batch and attachments return held after the real %s policy refusal", async (_name, get, message) => {
    const fixture = await refusedAdmission(get);
    const { fleet, services, turns, currentRun, release, settled, policyRead, append, rows, sent } = fixture;
    const batch: readonly [QueuedItem, QueuedItem, QueuedItem] = [
        {
            ...item("a1", "person", "alice"),
            turn: { prompt: "first instructions", conversationId: "c1", messageId: "a1", agent: "claude", isolated: true, attachments: ["draft.txt"], mentions: ["src/first.ts"] },
        },
        {
            ...item("a2", "person", "alice"),
            turn: { prompt: "second instructions", conversationId: "c1", messageId: "a2", agent: "codex", placement: { kind: "runner", id: "paired-runner" }, attachments: ["diagram.png"], mentions: ["src/second.ts"] },
        },
        {
            ...item("b1", "person", "bob"),
            turn: { prompt: "another person's words", conversationId: "c1", messageId: "b1", agent: "claude", attachments: ["other.txt"] },
        },
    ];
    for (const queued of batch) {
        await fleet.conversations.send("c1", { kind: "queue-joined", item: queued }).settled;
    }
    const [first, second, third] = fleet.conversations.queued("c1").items;
    if (first === undefined || second === undefined || third === undefined) { throw new Error("the queue did not keep all three messages"); }
    expect(fleet.conversations.queued("c1")).toEqual({ items: [{ ...batch[0], revision: 1 }, { ...batch[1], revision: 2 }, { ...batch[2], revision: 3 }], revision: 3 });
    // Seed the real receipts path, as say() does before delivery; refusal must change started receipts back to queued.
    expect(await receiptOf(services, "c1", "a1")).toEqual({ delivered: "queued" });
    await turns.drain("c1");
    const run = currentRun();
    const frames = framesOf(run);
    expect(run.done).toBe(false);
    expect(run.rows).toEqual([{
        role: "user", text: "first instructions\n\nsecond instructions", sentAt: run.startedAt,
        attachments: ["draft.txt", "diagram.png"], messageId: "a1", run: run.id,
    }]);
    expect(fleet.conversations.queued("c1")).toEqual({ items: [third], revision: 4 });
    expect(await receiptOf(services, "c1", "a1")).toEqual({ delivered: "started", run: run.id });
    expect(await receiptOf(services, "c1", "a2")).toEqual({ delivered: "started", run: run.id });

    release();
    await settled;
    expect(await frames).toEqual([{ kind: "error", code: "agent-domain-refused", message }, { kind: "done" }]);
    expect(run.done).toBe(true);
    expect(run.ranNothing).toBe(true);
    expect(append).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(fleet.conversations.state("c1")?.resume.held ?? null).toBe(null);

    // This is the same drain the run.settled listener invokes in composition, not a synthetic queue-returned event.
    await turns.drain("c1");
    const returned = {
        items: [{ ...first, revision: 5 }, { ...second, revision: 5 }, third],
        revision: 5,
        paused: "refused" as const,
    };
    expect(fleet.conversations.queued("c1")).toEqual(returned);
    await waitFor(() => expect(fleet.agents.entry("c1")?.queue).toEqual(returned));
    expect(await receiptOf(services, "c1", "a1")).toEqual({ delivered: "queued" });
    expect(await receiptOf(services, "c1", "a2")).toEqual({ delivered: "queued" });
    expect(sent.filter((event) => event.kind === "queue-returned").map((event) => event.items.map((queued) => queued.id))).toEqual([["a1", "a2"]]);
    expect(sent.filter((event) => event.kind === "begin" || event.kind === "frame" || event.kind === "settle")).toEqual([]);
    expect(fleet.agents.entry("c1")?.ending).toEqual({ kind: "idle" });
    expect(fleet.agents.entry("c1")?.totals).toEqual(UNCHANGED_TOTALS);

    // Another drain or a resend of the same message must neither consume it nor retry the refused turn automatically.
    await turns.drain("c1");
    expect(await turns.say({ turn: batch[0]!.turn, voice: "person" })).toEqual({ delivered: "queued", duplicate: true });
    expect(fleet.conversations.queued("c1")).toEqual(returned);
    expect(policyRead).toHaveBeenCalledTimes(1);
});

test.each(domainRefusals)("a senderless sandbox message is kept with its attachments after the real %s policy refusal", async (_name, get, message) => {
    const { fleet, turns, currentRun, release, settled, policyRead, append, rows, sent } = await refusedAdmission(get);
    const turn = { prompt: "repair the queued work", conversationId: "c1", messageId: "repair", agent: "claude" as const, isolated: true, attachments: ["repair.txt"] };
    const receipt = await turns.say({ turn, voice: "sandbox" });
    const run = currentRun();
    const frames = framesOf(run);
    expect(receipt).toEqual({ delivered: "started", run: run.id });
    release();
    await settled;

    expect(await frames).toEqual([
        { kind: "error", code: "agent-domain-refused", message, held: { ran: false } },
        { kind: "done" },
    ]);
    expect(fleet.conversations.state("c1")?.resume.held).toEqual({
        input: { ...turn, harness: "native", speaker: { kind: "sandbox" } },
        reason: "door", ran: false, run: run.id, recordedAt: expect.any(Number), fired: false, tries: 0,
    });
    // Kept turns deliberately record their unexecuted opening instead of setting ranNothing and returning to a queue.
    expect(run.ranNothing).toBe(false);
    expect(rows).toEqual([
        { role: "user", text: turn.prompt, sentAt: run.startedAt, attachments: ["repair.txt"], messageId: "repair", speaker: { kind: "sandbox" }, run: run.id },
        {
            role: "notice", text: `${message} Nothing has run yet: the message above is kept here to send again once that is sorted.`,
            noticeAction: "sendAgain", sandboxHeld: true,
            noticeCode: { code: "kept", params: { message, error: "agent-domain-refused" } }, run: run.id,
        },
    ]);
    expect(append).toHaveBeenCalledTimes(1);
    expect(fleet.conversations.queued("c1")).toEqual({ items: [], revision: 0 });
    expect(sent.filter((event) => event.kind === "turn-held").map((event) => event.held.ran)).toEqual([false]);
    expect(sent.filter((event) => event.kind === "begin" || event.kind === "frame" || event.kind === "settle")).toEqual([]);
    expect(fleet.agents.entry("c1")?.ending).toEqual({ kind: "idle" });
    expect(fleet.agents.entry("c1")?.totals).toEqual(UNCHANGED_TOTALS);
    expect(policyRead).toHaveBeenCalledTimes(1);
});
