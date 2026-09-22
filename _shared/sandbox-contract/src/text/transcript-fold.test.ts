import { STATE_DIR } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../events/agent-events.js";
import type { TranscriptPatch, TranscriptRow } from "../events/transcript.js";
import { watchWakePrompt } from "../events/watch-wake.js";
import { applyTranscriptPatch, foldTurn, TranscriptFold, userRow } from "./transcript-fold.js";

// Epoch ms stamped on the opening user row's sentAt.
const SENT_AT = 1_767_225_600_000;
const openingOf = (prompt: string): TranscriptRow[] => [userRow(prompt, SENT_AT, [])];
const foldOf = (prompt: string, events: readonly AgentEvent[]): TranscriptRow[] => foldTurn(openingOf(prompt), events);

// The one fold every window and the stored record draw from; pins what a live, reopened and stored chat all show.
describe("foldTurn", () => {
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

    it("leaves an unanswered call in progress", () => {
        const events: AgentEvent[] = [{ kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress" }];
        expect(foldOf("run", events).at(-1)?.tools?.[0]?.status).toBe("in_progress");
    });

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

    it("drops a subagent's frames when the card that spawned them is absent", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "delegating" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "completed", parentToolUseId: "task-1" },
        ];
        expect(foldOf("delegate", events).slice(1)).toEqual([{ role: "assistant", text: "delegating" }]);
    });

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

    it("yields nothing but the prompt for a turn that said nothing", () => {
        const events: AgentEvent[] = [{ kind: "init", model: "claude-opus-4" }, { kind: "done" }];
        expect(foldOf("hi", events)).toEqual([{ role: "user", text: "hi", sentAt: SENT_AT }]);
    });

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
        // The row states what happened and nothing more: what happens next, and the one control that changes it, are
        // the chat card's, asked once (ChatContinueStrip), not a second switch on a transcript line.
        expect(foldOf("hi", outage).at(-1)).toEqual({ role: "notice", text: "Anthropic is down. Retrying by itself: attempt 2 of 6." });
        const renewal: AgentEvent[] = [{ kind: "error", code: "claude-token-refused", message: "Token refused.", autoResume: "scheduled" }];
        expect(foldOf("hi", renewal).at(-1)).toEqual({
            role: "notice",
            text: "Token refused. The credential is being renewed and this turn continues automatically.",
            noticeWait: "credentialRenewal",
        });
    });

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

// Patches applied to a window's rows must reproduce the fold's own rows exactly, or live and reopened chats drift.
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

    // The other half of the wake's delivery: a live turn takes it as a steer. It is the daemon's own words either way,
    // so it must not become a user row here, and must not leave a rewind anchor pointing at a message nobody sent.
    it("writes a watch's wake into a live turn as a notice, and never as a steer to rewind to", () => {
        const prompt = watchWakePrompt({
            outcome: "timeout",
            id: "watch-1",
            note: "the deploy",
            elapsed: "2h",
            command: "curl -sf https://example.test/health",
            exitCode: 22,
            output: "404",
        });
        const fold = new TranscriptFold(openingOf("ship it"));
        fold.apply({ kind: "delta", text: "watching" });
        fold.apply({ kind: "steer", text: prompt, sentAt: SENT_AT + 1 });
        expect(fold.rows.map((row) => row.role)).toEqual(["user", "assistant", "notice"]);
        expect(fold.rows.at(-1)?.text).toBe("the deploy — the watch gave up after 2h.");
        expect(fold.steerRows).toEqual([]);
    });

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

    it("carry copies, not the fold's own rows", () => {
        const fold = new TranscriptFold(openingOf("go"));
        const [appended] = fold.apply({ kind: "delta", text: "a" });
        fold.apply({ kind: "delta", text: "b" });
        expect(appended).toEqual({ op: "append", row: { role: "assistant", text: "" } });
        expect(fold.rows[1]?.text).toBe("ab");
    });
});

// A refusal that ran nothing offers the message back to the composer — true where somebody typed one, false for a run
// that started itself, where there is no composer and no typed message.
describe(`a refusal that ran nothing`, () => {
    const REFUSED = { kind: `error`, code: `context-window-too-small`, message: `This model accepts 16,384 tokens.` } as const satisfies AgentEvent;

    it(`holds a turn somebody typed for another press`, () => {
        const rows = foldOf(`land it`, [REFUSED]);

        expect(rows.at(-1)?.text).toContain(`held for you to send again`);
    });

    it(`promises no resend for a turn that started itself`, () => {
        const rows = foldOf(`land it`, [{ ...REFUSED, unattended: true }]);

        expect(rows.at(-1)?.text).not.toContain(`send again`);
        expect(rows.at(-1)?.text).toContain(`started on its own`);
        // The provider's own sentence still leads, whichever clause follows it.
        expect(rows.at(-1)?.text).toContain(`16,384 tokens`);
    });

    // A refusal the reader can act on offers the press, and one they cannot does not. The reading is what tells
    // the two apart: the headroom refusal carries it, the stall refusal names no ceiling to move.
    it(`offers the memory raise only on a refusal that carried a reading`, () => {
        const GIB = 1024 ** 3;
        const outOfMemory = {
            kind: `error`,
            code: `sandbox-memory-low`,
            message: `Not enough sandbox memory to start this turn.`,
            memory: { limitBytes: 16 * GIB, residentBytes: 12 * GIB, swapBytes: 4 * GIB },
        } as const satisfies AgentEvent;

        const offered = foldOf(`land it`, [outOfMemory]).at(-1);
        expect(offered?.noticeAction).toBe(`sandboxMemory`);
        // Still a held refusal: the press is an addition to that row, not a replacement for it.
        expect(offered?.text).toContain(`held for you to send again`);

        const { memory: _stalled, ...noReading } = outOfMemory;
        expect(foldOf(`land it`, [noReading]).at(-1)?.noticeAction).toBeUndefined();
    });

    // The other held refusals share the sentence, not the button: nothing about a dead credential is fixed by a cap.
    it(`offers no press on the held refusals that a raise would not fix`, () => {
        expect(foldOf(`land it`, [REFUSED]).at(-1)?.noticeAction).toBeUndefined();
    });

    // The bug this retraction exists for: the composer keeps the words for another press, so a bubble left standing
    // here is the SAME message a second time, and a third, once per press against a gate that keeps refusing.
    it(`takes the message back out, leaving the composer's copy as the only one`, () => {
        const fold = new TranscriptFold(openingOf(`land it`));
        const patches = fold.apply(REFUSED);

        expect(fold.rows).toEqual([{ role: `notice`, text: expect.stringContaining(`held for you to send again`) }]);
        expect(fold.ranNothing).toBe(true);
        // Dropped ahead of the notice that stands in for it: a window applies patches in order, and an append first
        // would have it renumber every row under an index that is about to move.
        expect(patches).toEqual([
            { op: `drop`, index: 0 },
            { op: `append`, row: expect.objectContaining({ role: `notice` }) },
        ]);
    });

    // Three presses is what the screenshot of this bug showed: one paragraph, four times, with a refusal between each.
    it(`leaves nothing behind however many times the same message is refused`, () => {
        const pressed = [0, 1, 2].map(() => foldOf(`land it`, [REFUSED]));

        expect(pressed.flat().filter((row) => row.role === `user`)).toEqual([]);
    });

    it(`keeps the message of a run that started itself, which has no composer to repeat from`, () => {
        const fold = new TranscriptFold(openingOf(`land it`));
        fold.apply({ ...REFUSED, unattended: true });

        expect(fold.rows[0]).toEqual(expect.objectContaining({ role: `user`, text: `land it` }));
        expect(fold.ranNothing).toBe(false);
    });

    // A refusal is only a retraction where it refused the whole turn. One arriving after the agent has spoken ends a
    // turn that happened, and everything it said is kept and recorded.
    it(`keeps a turn the refusal interrupted rather than prevented`, () => {
        const fold = new TranscriptFold(openingOf(`land it`));
        fold.apply({ kind: `delta`, text: `on it` });
        fold.apply(REFUSED);

        expect(fold.rows.map((row) => row.role)).toEqual([`user`, `assistant`, `notice`]);
        expect(fold.ranNothing).toBe(false);
    });
});
