import { STATE_DIR } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import type { AgentEvent, TranscriptPatch, TranscriptRow } from "./events.js";
import { applyTranscriptPatch, foldTurn, TranscriptFold, userRow } from "./transcript-fold.js";

// When the turn started: what its user row is stamped with (TranscriptRow.sentAt).
const SENT_AT = 1_767_225_600_000;
const openingOf = (prompt: string): TranscriptRow[] => [userRow(prompt, SENT_AT, [])];
const foldOf = (prompt: string, events: readonly AgentEvent[]): TranscriptRow[] => foldTurn(openingOf(prompt), events);

/* THE ONE FOLD, tested where it lives. Every window draws these rows and the record keeps them, so what is
 * asserted here is what a chat shows live, what it shows reopened, and what the record holds: one set of rules,
 * one set of tests. */
describe("foldTurn", () => {
    /* The live bubble boundary: `text_end` retires the block that WROTE something, so the calls it introduced
     * land in a fresh bubble under it, and the prose that reports them joins that same bubble. This is Claude
     * Code's interleaving: says what it's about to do → the cards → what it found. */
    it("retires a prose bubble at text_end so the calls it introduced land beneath it", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "I'll look" },
            { kind: "text_end" },
            { kind: "tool_call", id: "t1", name: "Read", category: "read", status: "in_progress" },
            { kind: "delta", text: "found it" },
            { kind: "text_end" },
            { kind: "delta", text: "and here's why" },
        ];
        expect(foldOf("look", events).slice(1)).toEqual([
            { role: "assistant", text: "I'll look" },
            { role: "assistant", text: "found it", tools: [{ id: "t1", name: "Read", category: "read", status: "in_progress" }] },
            { role: "assistant", text: "and here's why" },
        ]);
    });

    /* THE USER SPOKE MID-TURN, and the rows hold it where the turn took it. It closes the open bubble: what the
     * agent says next is its answer to these words and belongs below them. */
    it("writes a mid-turn steer down as a user row, with the answer to it beneath", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "on it" },
            { kind: "steer", text: "and the tests", sentAt: SENT_AT + 1000, attachments: [`${STATE_DIR}/records/artifacts/attachments/u1/spec.md`] },
            { kind: "delta", text: "will do" },
        ];
        expect(foldOf("ship it", events).slice(1)).toEqual([
            { role: "assistant", text: "on it" },
            { role: "user", text: "and the tests", sentAt: SENT_AT + 1000, attachments: [".intentic/records/artifacts/attachments/u1/spec.md"] },
            { role: "assistant", text: "will do" },
        ]);
    });

    // A text_end on a bubble holding only cards is not a boundary: retiring there would split a card away from
    // the prose that reports it, a shape the live stream never draws.
    it("does not retire a bubble that has written no prose", () => {
        const events: AgentEvent[] = [
            { kind: "tool_call", id: "t1", name: "Read", category: "read", status: "completed" },
            { kind: "text_end" },
            { kind: "delta", text: "that's the file" },
        ];
        expect(foldOf("look", events).slice(1)).toEqual([
            { role: "assistant", text: "that's the file", tools: [{ id: "t1", name: "Read", category: "read", status: "completed" }] },
        ]);
    });

    it("settles a card from an update that lands turns after its call", () => {
        const events: AgentEvent[] = [
            { kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress", target: "pnpm test" },
            { kind: "text_end" },
            { kind: "delta", text: "meanwhile" },
            { kind: "tool_call_update", id: "t1", status: "failed", content: [{ type: "text", text: "1 failed" }] },
        ];
        expect(foldOf("test", events).flatMap((message) => message.tools ?? [])).toEqual([
            { id: "t1", name: "Bash", category: "execute", status: "failed", target: "pnpm test", content: [{ type: "text", text: "1 failed" }] },
        ]);
    });

    // A card the turn died mid-call keeps `in_progress`: that is what happened, and claiming a completion it
    // never reported would be the one thing a transcript must not invent.
    it("leaves an unanswered call in progress", () => {
        const events: AgentEvent[] = [{ kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress" }];
        expect(foldOf("run", events).at(-1)?.tools?.[0]?.status).toBe("in_progress");
    });

    /* A DELEGATION: its calls and its thinking nest under the Agent card that spawned them, so a delegation
     * reads as one unit rather than a leaf card. Its PROSE stays off the card: that card has nowhere to render
     * prose, and the child's report already arrives as the card's own result content. The child's live state
     * (the `subagent` frames) rides the same card. */
    it("nests a subagent's calls, thinking and live state under the card that spawned them", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "delegating" },
            { kind: "tool_call", id: "task-1", name: "Agent", category: "other", status: "in_progress" },
            { kind: "subagent", id: "task-1", subagentKind: "subagent", agentType: "Explore", background: true },
            { kind: "delta", text: "inner voice", parentToolUseId: "task-1" },
            { kind: "thinking", text: "hmm", parentToolUseId: "task-1" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "in_progress", parentToolUseId: "task-1" },
            { kind: "tool_call_update", id: "t2", status: "completed" },
            { kind: "subagent_update", id: "task-1", status: "completed", toolUses: 1 },
        ];
        expect(foldOf("delegate", events).at(-1)?.tools).toEqual([
            {
                id: "task-1",
                name: "Agent",
                category: "other",
                status: "in_progress",
                thinking: "hmm",
                children: [{ id: "t2", name: "Read", category: "read", status: "completed" }],
                subagent: { kind: "subagent", agentType: "Explore", background: true, status: "completed", toolUses: 1 },
            },
        ]);
    });

    // Its Agent card is not in this stream (a malformed log, or one level of a deeper spawn read on its own), so
    // there is nothing to hang the child off, which is exactly what keeps a nested level out of the level above.
    it("drops a subagent's frames when the card that spawned them is absent", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "delegating" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "completed", parentToolUseId: "task-1" },
        ];
        expect(foldOf("delegate", events).slice(1)).toEqual([{ role: "assistant", text: "delegating" }]);
    });

    // One subagent's own side of the same log: what the Subagents area renders while it runs. Read at the
    // child's level its prose IS top-level, the parent's frames are not its business, and the parent's cards
    // stay out: read at a subagent's own level a card is not that stream's.
    it("reads one subagent's stream as a transcript of its own", () => {
        const questions = [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }] }];
        const events: AgentEvent[] = [
            { kind: "delta", text: "parent prose" },
            { kind: "tool_call", id: "t1", name: "Grep", category: "search", status: "completed" },
            { kind: "delta", text: "found it", parentToolUseId: "task-1" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "completed", parentToolUseId: "task-1" },
            { kind: "question", requestId: "q1", questions },
        ];
        expect(foldTurn([], events, "settled", "task-1")).toEqual([
            { role: "assistant", text: "found it", tools: [{ id: "t2", name: "Read", category: "read", status: "completed" }] },
        ]);
    });

    it("records the thinking a turn showed", () => {
        const events: AgentEvent[] = [
            { kind: "thinking", text: "hm, " },
            { kind: "thinking", text: "maybe" },
            { kind: "delta", text: "yes" },
        ];
        expect(foldOf("think", events).at(-1)).toEqual({ role: "assistant", text: "yes", thinking: "hm, maybe" });
    });

    it("records the task checklist a turn maintained", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "planning" },
            { kind: "text_end" },
            {
                kind: "todos",
                items: [
                    { content: "step 1", status: "completed" },
                    { content: "step 2", status: "in_progress", activeForm: "Running step 2" },
                    { content: "step 3", status: "pending" },
                ],
            },
            { kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress" },
        ];
        expect(foldOf("run tasks", events)).toEqual([
            { role: "user", text: "run tasks", sentAt: SENT_AT },
            { role: "assistant", text: "planning" },
            {
                role: "assistant",
                text: "",
                todos: [
                    { content: "step 1", status: "completed" },
                    { content: "step 2", status: "in_progress", activeForm: "Running step 2" },
                    { content: "step 3", status: "pending" },
                ],
                tools: [{ id: "t1", name: "Bash", category: "execute", status: "in_progress" }],
            },
        ]);
    });

    // End-of-turn accounting lands on the bubble the answer ended in, and closes the turn: a steered
    // conversation's stream can carry several turns, and the next opens a fresh bubble below.
    it("attaches the turn's usage to its last bubble and closes it", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "done" },
            { kind: "usage", account: "a", costUsd: 0.5, inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 },
            { kind: "delta", text: "next turn" },
        ];
        expect(foldOf("go", events).slice(1)).toEqual([
            { role: "assistant", text: "done", usage: { costUsd: 0.5, inputTokens: 10, outputTokens: 5 } },
            { role: "assistant", text: "next turn" },
        ]);
    });

    // Frames that are not transcript (init, the settle) carry no bubble of their own, so a turn that only
    // emitted those folds to the prompt alone rather than an empty reply.
    it("yields nothing but the prompt for a turn that said nothing", () => {
        const events: AgentEvent[] = [{ kind: "init", model: "claude-opus-4" }, { kind: "done" }];
        expect(foldOf("hi", events)).toEqual([{ role: "user", text: "hi", sentAt: SENT_AT }]);
    });

    /* A REFUSED TURN SAYS SO. The provider's answer to this one is an error frame and no prose at all, so folding
     * only the two speakers left a question with no reply under it. The daemon's clause about what comes next
     * rides the same line, so the reopened chat and the live one read the same. */
    it("keeps what went wrong, as the notice line the turn ended on", () => {
        const refusal = "Your organization has disabled Claude subscription access for Claude Code";
        const events: AgentEvent[] = [{ kind: "delta", text: "I'll take a look" }, { kind: "error", message: refusal }, { kind: "done" }];
        expect(foldOf("hi", events)).toEqual([
            { role: "user", text: "hi", sentAt: SENT_AT },
            { role: "assistant", text: "I'll take a look" },
            { role: "notice", text: refusal },
        ]);
        const outage: AgentEvent[] = [
            {
                kind: "error",
                code: "provider-outage",
                message: "Anthropic is down.",
                autoResume: "scheduled",
                outage: { retryAt: 1, attempt: 2, maxAttempts: 6 },
            },
        ];
        expect(foldOf("hi", outage).at(-1)).toEqual({
            role: "notice",
            text: "Anthropic is down. Retrying by itself: attempt 2 of 6.",
            noticeAction: "outageOptOut",
        });
        const renewal: AgentEvent[] = [{ kind: "error", code: "claude-token-refused", message: "Token refused.", autoResume: "scheduled" }];
        expect(foldOf("hi", renewal).at(-1)).toEqual({
            role: "notice",
            text: "Token refused. The credential is being renewed and this turn continues automatically.",
            noticeWait: "credentialRenewal",
        });
    });

    /* AND SO DOES A TURN THAT RAN CHEAPER THAN THE MODEL ASKED FOR. Scrolling back a week later, "was THIS
     * answer the cheap one" is the question, and only a row per routed turn can answer it. The offer rides
     * along so the reopened line keeps its one press. A verdict that moved nothing writes nothing. */
    it("writes down a turn that ran on a cheaper model, and nothing for a verdict that moved nothing", () => {
        const routed: AgentEvent[] = [
            { kind: "tier", tier: "fast", score: 0.1, rules: ["easy-words"], model: "claude-haiku-4-5", routed: true },
            { kind: "delta", text: "a closure is…" },
        ];
        expect(foldOf("what is a closure?", routed)).toEqual([
            { role: "user", text: "what is a closure?", sentAt: SENT_AT },
            { role: "notice", text: "This turn looked simple, so it ran on claude-haiku-4-5 instead of your pick.", noticeAction: "tierHold" },
            { role: "assistant", text: "a closure is…" },
        ]);
        const held: AgentEvent[] = [
            { kind: "tier", tier: "fast", score: 0.1, rules: ["easy-words"], model: "claude-haiku-4-5", routed: false, held: true },
            { kind: "delta", text: "sure" },
        ];
        expect(foldOf("go", held).map((message) => message.role)).toEqual(["user", "assistant"]);
    });

    // What happened to the turn outside the model's words: a rebase, a landing, a compaction, each one line.
    it("writes the turn's own events down as notices", () => {
        const events: AgentEvent[] = [
            { kind: "worktree", branch: "agent/x", base: "abc1234", sync: { commits: 2, blocked: [] } },
            { kind: "delta", text: "on it" },
            { kind: "compact", trigger: "auto" },
            { kind: "landed", landed: true, deps: { missing: 1, started: ["deps-1"], deferred: false } },
        ];
        expect(foldOf("go", events).slice(1)).toEqual([
            { role: "notice", text: "Your workspace moved on while this agent waited, its branch was rebased onto your latest 2 commits." },
            { role: "assistant", text: "on it" },
            { role: "notice", text: "Context compacted to free up space." },
            {
                role: "notice",
                text: "Changes landed in your workspace: review them in the Changes panel. Installing 1 new dependency it added; the project's checks run when that finishes, and the outcome lands in Activity.",
                noticeAction: "depsInstall",
            },
        ]);
        expect(foldOf("go", [{ kind: "landed", landed: true, held: true }]).at(-1)?.text).toBe(
            "Finished: the work is on this agent's branch, ready to land from its review.",
        );
    });

    // The checkpoint and the daemon's notes land on the turn's own user row, where a reader finds them.
    it("stamps the checkpoint and the preamble's notes on the turn's user row", () => {
        const events: AgentEvent[] = [
            { kind: "checkpoint", id: "snap-1", index: 4 },
            { kind: "preamble", notes: [{ title: "Map of this project", text: "## Map" }] },
            { kind: "preamble", notes: [] },
            { kind: "delta", text: "on it" },
        ];
        expect(foldOf("fix the build", events)[0]).toEqual({
            role: "user",
            text: "fix the build",
            sentAt: SENT_AT,
            checkpointId: "snap-1",
            rewindIndex: 4,
            notes: [{ title: "Map of this project", text: "## Map" }],
        });
    });

    /* THE CARD THE TURN PARKED ON, and the answer that released it. The card takes the open bubble and closes it,
     * so the ask tool's own call (which trails its card) lands in the row beneath, with what the agent said once
     * answered. The reply settles the card's status by the one derivation (card-status.ts). */
    it("records the question a turn asked, with the picks that answered it, and closes the bubble on the card", () => {
        const questions = [
            {
                question: "Which?",
                header: "Pick",
                multiSelect: true,
                options: [
                    { label: "A", description: "a" },
                    { label: "B", description: "b" },
                ],
            },
        ];
        const events: AgentEvent[] = [
            { kind: "delta", text: "Two ways to go." },
            { kind: "text_end" },
            { kind: "question", requestId: "q1", questions },
            { kind: "tool_call", id: "t1", name: "mcp__ui__ask", category: "other", status: "in_progress" },
            { kind: "resolved", requestId: "q1", reply: { kind: "question", requestId: "q1", answers: { "Which?": ["A", "B"] } } },
            { kind: "tool_call_update", id: "t1", status: "completed" },
            { kind: "delta", text: "Both it is." },
        ];
        expect(foldOf("go", events).slice(1)).toEqual([
            { role: "assistant", text: "Two ways to go." },
            { role: "assistant", text: "", question: { requestId: "q1", questions, status: "answered", answers: { "Which?": ["A", "B"] } } },
            { role: "assistant", text: "Both it is.", tools: [{ id: "t1", name: "mcp__ui__ask", category: "other", status: "completed" }] },
        ]);
    });

    // A card raised under prose that is still open joins that prose, the one row; the answer's continuation
    // opens the next. A plan whose text IS the adjacent retired prose takes that row over instead of drawing
    // the same markdown twice.
    it("keeps the prose that led up to a card in the card's own row, and folds a repeated plan into its prose", () => {
        const document = { path: "docs/plan.md", title: "Plan", markdown: "# Plan\n\n1. do it" };
        const events: AgentEvent[] = [
            { kind: "delta", text: "Here is the plan." },
            { kind: "plan", requestId: "p1", text: "1. do it", document },
            { kind: "resolved", requestId: "p1", reply: { kind: "plan", requestId: "p1", approve: true } },
            { kind: "delta", text: "Doing it." },
        ];
        expect(foldOf("plan it", events).slice(1)).toEqual([
            { role: "assistant", text: "Here is the plan.", plan: { requestId: "p1", text: "1. do it", document, status: "approved" } },
            { role: "assistant", text: "Doing it." },
        ]);
        const repeated: AgentEvent[] = [
            { kind: "delta", text: "1. do it" },
            { kind: "text_end" },
            { kind: "plan", requestId: "p2", text: "1. do it" },
        ];
        expect(foldOf("plan it", repeated).slice(1)).toEqual([
            { role: "assistant", text: "", plan: { requestId: "p2", text: "1. do it", status: "cancelled" } },
        ]);
    });

    /* A card nobody answered is nobody's decision: when the turn ends under it, it freezes as `cancelled`, with
     * everything it was raised with intact — including the judge's sentence, which is what the user was actually
     * reading when the turn died. (The sentence arrives ON the card now rather than as a later frame patched
     * into it: it is the reason the card exists, so there was no card before it existed.) */
    it("freezes a card nobody answered as cancelled when the turn ends, keeping what it was raised with", () => {
        const events: AgentEvent[] = [
            { kind: "permission", requestId: "perm1", toolName: "Bash", title: "Claude wants to run pnpm test", explain: "Runs the test suite." },
        ];
        expect(foldOf("test", events).slice(1)).toEqual([
            {
                role: "assistant",
                text: "",
                permission: {
                    requestId: "perm1",
                    toolName: "Bash",
                    title: "Claude wants to run pnpm test",
                    explain: "Runs the test suite.",
                    status: "cancelled",
                },
            },
        ]);
    });

    // An offer's whole life is on its card: the click, the run showing itself living, and how the spend ended.
    it("keeps an offer's decision, its stream and its receipt on the card that offered it", () => {
        const offer = { slug: "research", name: "Research", publisher: "acme", description: "d", creditsPerRun: 3, request: "{}" };
        const events: AgentEvent[] = [
            { kind: "service_offer", requestId: "s1", offer },
            { kind: "resolved", requestId: "s1", reply: { kind: "service_offer", requestId: "s1", approve: true } },
            { kind: "service_event", requestId: "s1", event: { event: "status", text: "searching" } },
            { kind: "service_receipt", requestId: "s1", outcome: "ok", credits: 3, remaining: 7 },
            { kind: "delta", text: "Found it." },
        ];
        expect(foldOf("research", events).slice(1)).toEqual([
            {
                role: "assistant",
                text: "",
                serviceOffer: {
                    requestId: "s1",
                    offer,
                    status: "approved",
                    events: [{ event: "status", text: "searching" }],
                    receipt: { outcome: "ok", credits: 3, remaining: 7 },
                },
            },
            { role: "assistant", text: "Found it." },
        ]);
    });

    /* A GATED CREDENTIAL's card keeps WHO released it, not merely that something was approved: the approver is
     * the whole point of the gate, and the reply cannot carry them (it is the daemon that verified the
     * identity), so the receipt frame is the only place that name ever appears. */
    it("keeps who released a gated credential on the card that asked for it", () => {
        const offer = {
            subject: "DATABASE_URL",
            kind: "secret" as const,
            lane: "shell" as const,
            detail: "psql {{secret:DATABASE_URL}}",
            why: "run the migration",
            approvers: ["bob@corp.com"],
            scope: "use" as const,
        };
        const events: AgentEvent[] = [
            { kind: "credential_offer", requestId: "c1", offer },
            { kind: "resolved", requestId: "c1", reply: { kind: "credential_offer", requestId: "c1", approve: true } },
            { kind: "credential_receipt", requestId: "c1", outcome: "released", approvedBy: "bob@corp.com" },
            { kind: "delta", text: "Migrated." },
        ];
        expect(foldOf("migrate", events).slice(1)).toEqual([
            {
                role: "assistant",
                text: "",
                credentialOffer: { requestId: "c1", offer, status: "approved", receipt: { outcome: "released", approvedBy: "bob@corp.com" } },
            },
            { role: "assistant", text: "Migrated." },
        ]);
    });

    /* A release nobody answered is nobody's refusal. The deadline passing freezes the card `cancelled` and
     * writes NO receipt, because "refused" would name a decision a person never made — the same split the
     * gate's two refusal sentences make to the agent. */
    it("freezes an unanswered release as nobody's decision, with no receipt", () => {
        const offer = {
            subject: "reddit",
            kind: "capability" as const,
            lane: "session" as const,
            approvers: ["alice@corp.com"],
            scope: "conversation" as const,
        };
        const events: AgentEvent[] = [{ kind: "credential_offer", requestId: "c1", offer }];
        expect(foldTurn(openingOf("post it"), events, "stopped").slice(1)).toEqual([
            { role: "assistant", text: "", credentialOffer: { requestId: "c1", offer, status: "cancelled" } },
            { role: "notice", text: "Stopped." },
        ]);
    });

    // A turn the user stopped says so, after freezing whatever it was parked on.
    it("writes a stop down after cancelling what the turn was waiting on", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "half" },
            { kind: "question", requestId: "q1", questions: [] },
        ];
        expect(foldTurn(openingOf("go"), events, "stopped").slice(1)).toEqual([
            { role: "assistant", text: "half", question: { requestId: "q1", questions: [], status: "cancelled" } },
            { role: "notice", text: "Stopped." },
        ]);
    });
});

/* THE PATCHES, the other half of the same fold: what a window applies to the rows it holds must reproduce the
 * rows the fold holds, exactly, or the two drift and the reopened chat disagrees with the live one. */
describe("patches", () => {
    const replay = (
        opening: readonly TranscriptRow[],
        events: readonly AgentEvent[],
    ): { folded: TranscriptRow[]; applied: TranscriptRow[]; patches: TranscriptPatch[] } => {
        const fold = new TranscriptFold(opening);
        const patches: TranscriptPatch[] = [];
        let applied: TranscriptRow[] = [...opening];
        for (const event of events) {
            for (const patch of fold.apply(event)) {
                patches.push(patch);
                applied = applyTranscriptPatch(applied, patch);
            }
        }
        for (const patch of fold.finish("settled")) {
            patches.push(patch);
            applied = applyTranscriptPatch(applied, patch);
        }
        return { folded: fold.rows, applied, patches };
    };

    it("reproduce the fold's rows exactly, through every kind of change", () => {
        const events: AgentEvent[] = [
            { kind: "checkpoint", id: "snap", index: 0 },
            { kind: "thinking", text: "hm" },
            { kind: "delta", text: "I'll " },
            { kind: "delta", text: "look" },
            { kind: "text_end" },
            { kind: "tool_call", id: "task-1", name: "Agent", category: "other", status: "in_progress" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "in_progress", parentToolUseId: "task-1" },
            { kind: "thinking", text: "inner", parentToolUseId: "task-1" },
            { kind: "tool_call_update", id: "t2", status: "completed" },
            { kind: "todos", items: [{ content: "a", status: "pending" }] },
            { kind: "steer", text: "also", sentAt: SENT_AT + 1 },
            { kind: "delta", text: "sure" },
            { kind: "question", requestId: "q", questions: [] },
            { kind: "resolved", requestId: "q", reply: { kind: "question", requestId: "q", cancelled: true } },
            { kind: "usage", costUsd: 1 },
        ];
        const { folded, applied, patches } = replay(openingOf("go"), events);
        expect(applied).toEqual(folded);
        expect(patches.map((patch) => patch.op)).toEqual([
            "replace",
            "append",
            "thinking",
            "text",
            "text",
            "append",
            "tool",
            "tool",
            "tool",
            "tool",
            "replace",
            "append",
            "append",
            "text",
            "replace",
            "replace",
            "replace",
        ]);
    });

    // A bubble the fold opened and never wrote into is dropped, and it was the last row, so nothing above moves.
    it("drop an empty bubble the turn opened and abandoned", () => {
        const events: AgentEvent[] = [
            { kind: "todos", items: [] },
            { kind: "steer", text: "hey", sentAt: SENT_AT },
        ];
        const { folded, applied, patches } = replay(openingOf("go"), events);
        expect(patches.map((patch) => patch.op)).toEqual(["append", "replace", "drop", "append"]);
        expect(applied).toEqual(folded);
        expect(folded.map((row) => row.role)).toEqual(["user", "user"]);
    });

    // A patch carries a COPY: the row the fold keeps mutating afterwards must not reach back into a patch that
    // was already handed out, or a slow reader applies a delta on top of text that already holds it.
    it("carry copies, not the fold's own rows", () => {
        const fold = new TranscriptFold(openingOf("go"));
        const [appended] = fold.apply({ kind: "delta", text: "a" });
        fold.apply({ kind: "delta", text: "b" });
        expect(appended).toEqual({ op: "append", row: { role: "assistant", text: "" } });
        expect(fold.rows[1]?.text).toBe("ab");
    });
});
