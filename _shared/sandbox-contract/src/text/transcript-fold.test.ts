import { STATE_DIR } from "@intentic/constants";
import type { AgentEvent } from "../events/agent-events.js";
import { type TranscriptPatch, type TranscriptRow, TranscriptRowSchema } from "../events/transcript.js";
import { sandboxNoticeOf } from "../events/sandbox-notice.js";
import { watchWakePrompt } from "../events/watch-wake.js";
import { LAND_CONFLICT_OPENING } from "../events/land-conflict.js";
import { RESUME_NOTES } from "../events/resume.js";
import { childReportPrompt, peerMessagePrompt } from "../events/agent-words.js";
import { applyTranscriptPatch, foldTurn, TranscriptFold, userRow } from "./transcript-fold.js";

// Epoch ms stamped on the opening user row's sentAt.
const SENT_AT = 1_767_225_600_000;
const openingOf = (prompt: string): TranscriptRow[] => [userRow(prompt, SENT_AT, [])];
const foldOf = (prompt: string, events: readonly AgentEvent[]): TranscriptRow[] => foldTurn(openingOf(prompt), events);
// What an armed credential renewal's row promises.
const RENEWING_TEXT = "The credential is being renewed and this turn continues automatically.";
// The same row as a code, which an app words in its reader's language (sandbox-notice.ts).
const RENEWING_CODE = { code: "renewing", params: { message: "Token refused.", error: "claude-token-refused" } };

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

    // The sandbox's composed words (a land's breakage sent back into the live turn) are not the owner's: the row says who
    // spoke them and what for, and a person's steer carries neither.
    it("writes the sandbox's steer down with its speaker and errand, and a person's with neither", () => {
        const events: AgentEvent[] = [
            { kind: "steer", text: "the land broke main", sentAt: SENT_AT + 1, voice: "sandbox", errand: "land-breakage" },
            { kind: "steer", text: "and the docs", sentAt: SENT_AT + 2 },
        ];
        expect(foldOf("ship it", events).slice(1)).toEqual([
            { role: "user", text: "the land broke main", sentAt: SENT_AT + 1, speaker: { kind: "sandbox" }, errand: "land-breakage" },
            { role: "user", text: "and the docs", sentAt: SENT_AT + 2 },
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

    // A spawned subagent is named by its own conversation, not the call that started it; the spawn answers with that
    // name, which is how its card is found, so it reads on its card exactly as an in-process one does.
    it("puts a spawned subagent on the card of the call whose result names it", () => {
        const events: AgentEvent[] = [
            { kind: "tool_call", id: "call-9", name: "mcp__subagents__spawn", category: "other", status: "in_progress" },
            { kind: "subagent", id: "sub-brave-otter", subagentKind: "spawned", agentType: "Codex", description: "Port the parser", provider: "codex", background: true },
            { kind: "subagent_update", id: "sub-brave-otter", status: "pending", summary: "Waiting for memory." },
            { kind: "tool_call_update", id: "call-9", status: "completed", content: [{ type: "text", text: '{"ok":true,"child":"sub-brave-otter"}' }] },
            { kind: "subagent_update", id: "sub-brave-otter", status: "running", toolUses: 3, lastTool: "Edit" },
        ];
        expect(foldOf("fan out", events).at(-1)?.tools).toEqual([
            {
                id: "call-9",
                name: "mcp__subagents__spawn",
                category: "other",
                status: "completed",
                content: [{ type: "text", text: '{"ok":true,"child":"sub-brave-otter"}' }],
                subagent: {
                    id: "sub-brave-otter",
                    kind: "spawned",
                    agentType: "Codex",
                    description: "Port the parser",
                    provider: "codex",
                    background: true,
                    status: "running",
                    summary: "Waiting for memory.",
                    toolUses: 3,
                    lastTool: "Edit",
                },
            },
        ]);
    });

    // The shell door prints the new id on its first line, so a runtime with no spawn tool of its own gets the same card.
    it("puts a subagent spawned from the shell on its command's card", () => {
        const events: AgentEvent[] = [
            { kind: "subagent", id: "sub-quiet-fox", subagentKind: "spawned", agentType: "Grok", description: "Draft the docs" },
            { kind: "tool_call", id: "b1", name: "Bash", category: "execute", status: "in_progress", target: "agents spawn --provider grok --model grok-4 'Draft the docs'" },
            { kind: "tool_call_update", id: "b1", status: "completed", content: [{ type: "text", text: "sub-quiet-fox\nStarted." }] },
            { kind: "subagent_update", id: "sub-quiet-fox", status: "completed", summary: "Drafted." },
        ];
        expect(foldOf("fan out", events).at(-1)?.tools?.[0]?.subagent).toEqual({
            id: "sub-quiet-fox",
            kind: "spawned",
            agentType: "Grok",
            description: "Draft the docs",
            status: "completed",
            summary: "Drafted.",
        });
    });

    // Parallel spawns answer in any order; each card takes the one its own result names, and a card holds one subagent.
    it("keeps each of several spawned subagents on its own card", () => {
        const events: AgentEvent[] = [
            { kind: "tool_call", id: "s1", name: "mcp__subagents__spawn", category: "other", status: "in_progress" },
            { kind: "tool_call", id: "s2", name: "mcp__subagents__spawn", category: "other", status: "in_progress" },
            { kind: "subagent", id: "sub-a", subagentKind: "spawned", description: "A" },
            { kind: "subagent", id: "sub-b", subagentKind: "spawned", description: "B" },
            { kind: "tool_call_update", id: "s2", status: "completed", content: [{ type: "text", text: '{"ok":true,"child":"sub-b"}' }] },
            { kind: "tool_call_update", id: "s1", status: "completed", content: [{ type: "text", text: '{"ok":true,"child":"sub-a"}' }] },
            { kind: "tool_call", id: "w1", name: "mcp__subagents__wait", category: "other", status: "in_progress" },
            { kind: "tool_call_update", id: "w1", status: "completed", content: [{ type: "text", text: '{"agent":{"id":"sub-a"},"also":"sub-b"}' }] },
        ];
        const tools = foldOf("fan out", events).at(-1)?.tools ?? [];
        expect(tools.map((tool) => [tool.id, tool.subagent?.id, tool.subagent?.description])).toEqual([
            ["s1", "sub-a", "A"],
            ["s2", "sub-b", "B"],
            ["w1", undefined, undefined],
        ]);
    });

    // An in-process subagent heard a beat before its call still lands on that call, under the call's own id.
    it("holds a subagent heard before its card until the card appears", () => {
        const events: AgentEvent[] = [
            { kind: "subagent", id: "task-2", subagentKind: "subagent", agentType: "Explore" },
            { kind: "tool_call", id: "task-2", name: "Agent", category: "other", status: "in_progress" },
        ];
        expect(foldOf("delegate", events).at(-1)?.tools?.[0]?.subagent).toEqual({ kind: "subagent", agentType: "Explore", status: "running" });
    });

    // Live, the card's claim goes out as the patch of the result that made it, so a watching window draws the same card.
    it("sends a spawned subagent's placement as the claiming card's own patch", () => {
        const fold = new TranscriptFold(openingOf("fan out"));
        fold.apply({ kind: "tool_call", id: "call-9", name: "mcp__subagents__spawn", category: "other", status: "in_progress" });
        expect(fold.apply({ kind: "subagent", id: "sub-x", subagentKind: "spawned", description: "Port" })).toEqual([]);
        const [patch] = fold.apply({ kind: "tool_call_update", id: "call-9", status: "completed", content: [{ type: "text", text: "sub-x" }] });
        expect(patch).toEqual({
            op: "tool",
            index: 1,
            tool: {
                id: "call-9",
                name: "mcp__subagents__spawn",
                category: "other",
                status: "completed",
                content: [{ type: "text", text: "sub-x" }],
                subagent: { id: "sub-x", kind: "spawned", description: "Port", status: "running" },
            },
        });
        expect(fold.apply({ kind: "subagent_update", id: "sub-x", status: "blocked", summary: "Which port?" })).toEqual([
            {
                op: "tool",
                index: 1,
                tool: expect.objectContaining({ subagent: { id: "sub-x", kind: "spawned", description: "Port", status: "blocked", summary: "Which port?" } }),
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
                outage: { retryAt: 1 },
                retries: { made: 1, max: 6 },
            },
        ];
        // The row states what happened and nothing more: what happens next, and the one control that changes it, are
        // the chat card's, asked once (ChatContinueStrip), not a second switch on a transcript line.
        expect(foldOf("hi", outage).at(-1)).toEqual({
            role: "notice",
            text: "Anthropic is down. Retrying by itself: attempt 2 of 6.",
            noticeCode: { code: "retrying", params: { message: "Anthropic is down.", error: "provider-outage", attempt: 2, of: 6 } },
        });
        const renewal: AgentEvent[] = [{ kind: "error", code: "claude-token-refused", message: "Token refused.", autoResume: "scheduled" }];
        expect(foldOf("hi", renewal).at(-1)).toEqual({
            role: "notice",
            text: "Token refused. The credential is being renewed and this turn continues automatically.",
            noticeWait: "credentialRenewal",
            noticeCode: RENEWING_CODE,
        });
    });

    // The sandbox keeps one hold per run and each failure replaces it: a stop right after an armed renewal is what it acts
    // on, so the renewal row must stop promising a continuation that is never coming (one sat in a chat for 41 minutes).
    it("takes back a renewal's promise when a later failure in the same run stops the turn", () => {
        const refused: AgentEvent = { kind: "error", code: "claude-token-refused", message: "Token refused.", autoResume: "scheduled" };
        const stopped: AgentEvent = { kind: "error", message: "Claude Code returned an error result: 401." };
        const fold = new TranscriptFold(openingOf("hi"));
        fold.apply(refused);
        const patches = fold.apply(stopped);
        // The code moves with the words, so an app wording the row itself says the stop too, not the old promise.
        const withdrawn: TranscriptRow = {
            role: "notice",
            text: "Token refused. The credential was being renewed, but the turn stopped before it could continue: it will not carry on by itself, so press Continue to pick it back up.",
            noticeCode: { code: "renewalWithdrawn", params: { message: "Token refused.", error: "claude-token-refused" } },
        };
        // The live window hears the rewrite as a patch on the row it already drew, then the stop's own row.
        expect(patches).toEqual([
            { op: "replace", index: 1, row: withdrawn },
            { op: "append", row: { role: "notice", text: "Claude Code returned an error result: 401." } },
        ]);
        expect(fold.rows.slice(1)).toEqual([withdrawn, { role: "notice", text: "Claude Code returned an error result: 401." }]);
        // A renewal armed again keeps its promise.
        const again = new TranscriptFold(openingOf("hi"));
        again.apply(refused);
        const renewing: TranscriptRow = { role: "notice", text: `Token refused. ${RENEWING_TEXT}`, noticeWait: "credentialRenewal", noticeCode: RENEWING_CODE };
        expect(again.apply(refused)).toEqual([{ op: "append", row: renewing }]);
        expect(again.rows[1]).toEqual(renewing);
    });

    // The count lives in the record, so a reader scrolling back sees how many times a stuck turn was sent again.
    it("says on a stopped turn's row which automatic try comes next, or that the ladder stood down", () => {
        const timedOut = "Google turn timed out waiting for OpenCode.";
        const booked: AgentEvent[] = [{ kind: "error", message: timedOut, autoResume: "scheduled", nextAt: 1, retries: { made: 1, max: 3 } }];
        expect(foldOf("hi", booked).at(-1)).toEqual({
            role: "notice",
            text: `${timedOut} Retrying by itself: attempt 2 of 3.`,
            noticeCode: { code: "retrying", params: { message: timedOut, attempt: 2, of: 3 } },
        });
        const spent: AgentEvent[] = [{ kind: "error", message: timedOut, autoResume: "available", retries: { made: 3, max: 3 } }];
        expect(foldOf("hi", spent).at(-1)).toEqual({
            role: "notice",
            text: `${timedOut} Retried 3 of 3 times by itself; nothing more is sent automatically.`,
            noticeCode: { code: "retried", params: { message: timedOut, made: 3, of: 3 } },
        });
        // An outage nobody armed says so, instead of promising the breaker's retry.
        const unarmed: AgentEvent[] = [
            {
                kind: "error",
                code: "provider-outage",
                message: "Anthropic is down.",
                autoResume: "available",
                outage: { retryAt: 1 },
                retries: { made: 0, max: 6 },
            },
        ];
        expect(foldOf("hi", unarmed).at(-1)).toEqual({
            role: "notice",
            text: "Anthropic is down. Nothing is retrying it, so the turn is waiting here.",
            noticeCode: { code: "outageWaiting", params: { message: "Anthropic is down.", error: "provider-outage" } },
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
            {
                role: "notice",
                text: "Your workspace moved on while this agent waited, its branch was rebased onto your latest 2 commits.",
                noticeCode: { code: "synced", params: { commits: 2 } },
            },
            { role: "assistant", text: "on it" },
            { role: "notice", text: "Context compacted to free up space.", noticeCode: { code: "compacted" } },
            {
                role: "notice",
                text: "Changes landed in your workspace: review them in the Changes panel. Installing 1 dependency it added or changed; the project's checks run when that finishes, and the outcome lands in Activity.",
                noticeAction: "depsInstall",
                noticeCode: { code: "landed", params: { deps: 1 } },
            },
        ]);
        expect(foldOf("go", [{ kind: "landed", landed: true, held: true }]).at(-1)).toEqual({
            role: "notice",
            text: "Finished: the work is on this agent's branch, ready to land from its review.",
            noticeCode: { code: "landHeld" },
        });
    });

    // What a runtime's extension said is a notice row a reopened chat still shows; its status line is live state only.
    it("folds an extension's notice into a notice row and keeps its status entries out of the rows", () => {
        const rows = foldOf("go", [
            { kind: "agent_status", key: "lint", text: "linting…", source: "lint-ext" },
            { kind: "agent_notice", level: "warning", text: "Command blocked by user", source: "guard-ext" },
            { kind: "agent_notice", level: "info", text: "Compacting soon" },
            { kind: "agent_notice", level: "error", text: "   " },
        ]);
        expect(rows.slice(1)).toEqual([
            { role: "notice", text: "Command blocked by user", agentNotice: { level: "warning", source: "guard-ext" } },
            { role: "notice", text: "Compacting soon", agentNotice: { level: "info" } },
        ]);
        expect(rows.slice(1).map((row) => TranscriptRowSchema.parse(row))).toEqual(rows.slice(1));
    });

    // An agent's own install, let through the command gate, says where it writes before its output arrives.
    it("says where an agent's own install writes, naming its projects", () => {
        expect(foldOf("go", [{ kind: "install", reach: "own-copy", projects: ["video"] }]).at(-1)).toEqual({
            role: "notice",
            text: "Installing packages in video/ into this conversation's own copy. The manifest and lockfile land with the work, and the review lists what it adds.",
            noticeCode: { code: "installing", params: { ownCopy: true, projects: "video/" } },
        });
        expect(foldOf("go", [{ kind: "install", reach: "main-tree", projects: [""] }]).at(-1)).toEqual({
            role: "notice",
            text: "Installing packages in the workspace root in the main tree, one install at a time.",
            noticeCode: { code: "installing", params: { ownCopy: false, root: true } },
        });
        // The workspace root is named first, and counts toward the three named.
        expect(foldOf("go", [{ kind: "install", reach: "main-tree", projects: ["a", "", "b", "c", "d"] }]).at(-1)).toEqual({
            role: "notice",
            text: "Installing packages in the workspace root, a/, b/ and 2 more in the main tree, one install at a time.",
            noticeCode: { code: "installing", params: { ownCopy: false, root: true, projects: "a/, b/", more: 2 } },
        });
        expect(foldOf("go", [{ kind: "install", reach: "main-tree", projects: ["a", "b", "c", "d", "e"] }]).at(-1)?.text).toBe(
            "Installing packages in a/, b/, c/ and 2 more in the main tree, one install at a time.",
        );
        expect(foldOf("go", [{ kind: "install", reach: "own-copy", projects: [] }]).at(-1)?.text).toBe(
            "Installing packages into this conversation's own copy. The manifest and lockfile land with the work, and the review lists what it adds.",
        );
    });

    // The reconciler starts a land's install within seconds, in the install lane; it never waits for turns to end, so
    // the notice must not say it does.
    it("says a land's dependency install is on its way, not waiting for other agents", () => {
        expect(foldOf("go", [{ kind: "landed", landed: true, deps: { missing: 3, started: [], deferred: true } }]).at(-1)).toEqual({
            role: "notice",
            text: "Changes landed in your workspace: review them in the Changes panel. 3 dependencies it added or changed are being installed in your tree: the install waits for any other install to finish, appears in Work terminals, and its outcome lands in Activity.",
            noticeAction: "landHold",
            noticeCode: { code: "landed", params: { deps: 3, queued: true } },
        });
    });

    // A spawned child's work goes into its parent's checkout, as the parent's in-process subagents' edits do: the row
    // says so, never that it reached the owner's workspace, and says who is to bring in a clash.
    it("says a child's work went into its parent's checkout, or was held off it by a clash", () => {
        expect(foldOf("go", [{ kind: "landed", landed: true, into: "p1" }]).at(-1)).toEqual({
            role: "notice",
            text: "Changes went into the parent agent's checkout, as its in-process subagents' edits do: they reach your workspace with its land.",
            noticeCode: { code: "intoParent" },
        });
        const clash: AgentEvent = { kind: "landed", landed: false, into: "p1", conflicts: [{ repo: "root", paths: [{ path: "app.ts", reason: "diverged" }], clean: 0 }] };
        expect(foldOf("go", [clash]).at(-1)).toEqual({
            role: "notice",
            text: "1 file(s) clash with the parent agent's own edits, so nothing was written into its checkout. The parent was told, and can bring the changes in to resolve.",
            noticeCode: { code: "intoParentClash", params: { files: 1 } },
        });
    });

    // A resolve turn exists because the branch couldn't rebase; its own opening rebase failing the same way is that
    // errand said twice, one row under itself. Any other turn still hears it, and a resolve turn still hears what moved.
    it("leaves the blocked rebase out of a land-conflict turn's notice, and only that", () => {
        const blocked: AgentEvent = { kind: "worktree", branch: "agent/x", base: "abc1234", sync: { commits: 0, blocked: ["intentic"] } };
        const resolve = `${LAND_CONFLICT_OPENING}\n\n1. \`git add -A && git commit\``;
        expect(foldOf(resolve, [blocked])).toEqual(openingOf(resolve));
        expect(foldOf(`${RESUME_NOTES.restart}\n\n${resolve}`, [blocked]).slice(1)).toEqual([]);
        expect(foldOf("go", [blocked]).slice(1)).toEqual([
            {
                role: "notice",
                text: "Couldn't rebase onto your workspace in intentic: the turn is running from the older base, so its land may need a resolve.",
                noticeCode: { code: "synced", params: { commits: 0, blocked: "intentic" } },
            },
        ]);
        const mixed: AgentEvent = { kind: "worktree", branch: "agent/x", base: "abc1234", sync: { commits: 3, blocked: ["intentic"] } };
        // The code leaves out what the words leave out: the resolve turn is not told its own errand in any language.
        expect(foldOf(resolve, [mixed]).slice(1)).toEqual([
            {
                role: "notice",
                text: "Your workspace moved on while this agent waited, its branch was rebased onto your latest 3 commits.",
                noticeCode: { code: "synced", params: { commits: 3 } },
            },
        ]);
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

    // A run carried on after a restart opens on the rows it had drawn and raises its parked cards again (turn-resume.ts,
    // carriedRun): each lands on the row it already stands on, and settles there, never drawn a second time beneath.
    it("puts a card raised again under an id its opening holds back where it stands, and settles it there", () => {
        const plan = { requestId: "p1", text: "1. ship", status: "pending" as const };
        const question = { requestId: "q1", questions: [], status: "pending" as const };
        const opening: TranscriptRow[] = [
            ...openingOf("go"),
            { role: "assistant", text: "Here is the plan.", plan },
            { role: "assistant", text: "", question },
        ];
        const events: AgentEvent[] = [
            { kind: "plan", requestId: "p1", text: "1. ship" },
            { kind: "question", requestId: "q1", questions: [] },
            { kind: "resolved", requestId: "q1", reply: { kind: "question", requestId: "q1", answers: { "Which?": ["A"] } } },
            { kind: "resolved", requestId: "p1" },
        ];
        expect(foldTurn(opening, events).slice(1)).toEqual([
            { role: "assistant", text: "Here is the plan.", plan: { ...plan, status: "cancelled" } },
            { role: "assistant", text: "", question: { ...question, status: "answered", answers: { "Which?": ["A"] } } },
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
            { role: "notice", text: "Stopped.", noticeCode: { code: "stopped" } },
        ]);
    });

    it("writes a stop down after cancelling what the turn was waiting on", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "half" },
            { kind: "question", requestId: "q1", questions: [] },
        ];
        expect(foldTurn(openingOf("go"), events, "stopped").slice(1)).toEqual([
            { role: "assistant", text: "half", question: { requestId: "q1", questions: [], status: "cancelled" } },
            { role: "notice", text: "Stopped.", noticeCode: { code: "stopped" } },
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
            "toolThinking",
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

    // A subagent thinks a token at a time; sending the spawning card whole each time would resend every child it holds.
    it("sends a subagent's reasoning as its words alone, onto the card that spawned it", () => {
        const fold = new TranscriptFold(openingOf("go"));
        fold.apply({ kind: "tool_call", id: "task-1", name: "Agent", category: "other", status: "in_progress" });
        fold.apply({ kind: "tool_call", id: "t2", name: "Read", category: "read", status: "completed", parentToolUseId: "task-1" });
        expect(fold.apply({ kind: "thinking", text: "the handler", parentToolUseId: "task-1" })).toEqual([
            { op: "toolThinking", index: 1, id: "task-1", text: "the handler" },
        ]);
        expect(fold.apply({ kind: "thinking", text: "", parentToolUseId: "task-1" })).toEqual([]);
        expect(fold.rows[1]?.tools?.[0]?.thinking).toBe("the handler");
    });

    it("send a delegation's card without its subtree or thinking, and a client keeps the ones it has", () => {
        const events: AgentEvent[] = [
            { kind: "tool_call", id: "task-1", name: "Agent", category: "other", status: "in_progress" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "in_progress", parentToolUseId: "task-1" },
            { kind: "thinking", text: "in", parentToolUseId: "task-1" },
            { kind: "thinking", text: "ner", parentToolUseId: "task-1" },
            { kind: "tool_call_update", id: "task-1", status: "completed" },
        ];
        const { folded, applied, patches } = replay(openingOf("go"), events);
        expect(applied).toEqual(folded);
        expect(patches.filter((patch) => patch.op === "toolThinking")).toEqual([
            { op: "toolThinking", index: 1, id: "task-1", text: "in" },
            { op: "toolThinking", index: 1, id: "task-1", text: "ner" },
        ]);
        const update = patches.at(-1);
        expect(update?.op === "tool" ? update.tool : undefined).toEqual({ id: "task-1", name: "Agent", category: "other", status: "completed" });
        expect(applied[1]?.tools?.[0]).toMatchObject({ status: "completed", thinking: "inner", children: [{ id: "t2" }] });
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

    // Another agent's words are drawn as theirs, never as the owner's.
    it("writes a peer's message and a child's report into a live turn as notices, not as the owner's words", () => {
        const fold = new TranscriptFold(openingOf("ship it"));
        fold.apply({
            kind: "steer",
            text: peerMessagePrompt({ from: "sharp-shale-htw8", title: "Bun migration", message: "done" }),
            sentAt: SENT_AT + 1,
            voice: "agent",
        });
        fold.apply({
            kind: "steer",
            text: childReportPrompt({ child: "sub-x7", title: "Port the parser", failed: false, report: "ported", verification: undefined }),
            sentAt: SENT_AT + 2,
            voice: "sandbox",
        });
        expect(fold.rows.slice(1)).toMatchObject([
            { role: "notice", agentWords: { kind: "peer", from: "sharp-shale-htw8" } },
            { role: "notice", agentWords: { kind: "child", from: "sub-x7" } },
        ]);
        expect(fold.steerRows).toEqual([]);
    });

    // An anchor from any other voice would shift every later person's anchor onto the wrong message.
    it("anchors only a person's steer, even when another voice's words draw as a user row", () => {
        const fold = new TranscriptFold(openingOf("ship it"));
        fold.apply({ kind: "steer", text: "also cover the parser", sentAt: SENT_AT + 1, voice: "agent" });
        fold.apply({ kind: "steer", text: "and the docs", sentAt: SENT_AT + 2 });
        expect(fold.rows.map((row) => row.role)).toEqual(["user", "user", "user"]);
        expect(fold.steerRows).toEqual([2]);
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

// A refusal that ran nothing offers the message back for another press — true where somebody typed one, false for a
// run that started itself, where there is no composer and no typed message.
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

    // The daemon lets a person's next send through once it has warned them, so the row says so and always offers it;
    // the raise joins only when the hold carried a ceiling to size it by, which a stall does not.
    describe(`on a sandbox short of memory`, () => {
        const GIB = 1024 ** 3;
        const lowMemory = {
            kind: `error`,
            code: `sandbox-memory-low`,
            message: `Sandbox memory is low: 12.0 GiB resident + 4.0 GiB swapped, against 16.0 GiB.`,
            memory: { limitBytes: 16 * GIB, residentBytes: 12 * GIB, swapBytes: 4 * GIB },
        } as const satisfies AgentEvent;

        it(`tells the reader that sending again starts it, and offers both presses when there is a ceiling to raise`, () => {
            const row = foldOf(`land it`, [lowMemory]).at(-1);
            expect(row?.text).toBe(`${lowMemory.message} Your message is held: send it again to start anyway.`);
            expect(row?.noticeAction).toBe(`sandboxMemory`);
        });

        it(`offers only the send on a stall, which names no ceiling`, () => {
            const { memory: _stalled, ...noReading } = lowMemory;
            const row = foldOf(`land it`, [noReading]).at(-1);
            expect(row?.noticeAction).toBe(`sendAnyway`);
            expect(row?.text).toContain(`send it again to start anyway`);
        });

        it(`offers nothing on a background turn, which has no message to send`, () => {
            const row = foldOf(`land it`, [{ ...lowMemory, unattended: true }]).at(-1);
            expect(row?.noticeAction).toBeUndefined();
            expect(row?.text).toContain(`started on its own`);
        });
    });

    // The other held refusals share the sentence, not the button: nothing about a dead credential is fixed by a cap.
    it(`offers no press on the held refusals that a raise would not fix`, () => {
        expect(foldOf(`land it`, [REFUSED]).at(-1)?.noticeAction).toBeUndefined();
    });

    // The bug this retraction exists for: the conversation's queue keeps the words for another press, so a bubble left
    // standing here is the SAME message a second time, and a third, once per press against a gate that keeps refusing.
    it(`takes the message back out, leaving the queue's copy as the only one`, () => {
        const fold = new TranscriptFold(openingOf(`land it`));
        const patches = fold.apply(REFUSED);

        expect(fold.rows).toEqual([
            {
                role: `notice`,
                text: expect.stringContaining(`held for you to send again`),
                noticeCode: { code: `undelivered`, params: { message: REFUSED.message, error: REFUSED.code } },
            },
        ]);
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

    // The sandbox, not a composer, keeps a turn it started itself (a fix press, a peer's message): the frame says so
    // with `held`. The bug this exists for: such a refusal took the fix prompt out, and no queue anywhere held a copy.
    describe(`of a turn the sandbox keeps`, () => {
        const kept = { ...REFUSED, held: { ran: false } } as const satisfies AgentEvent;

        it(`leaves the message where it was, and is recorded like any turn`, () => {
            const fold = new TranscriptFold(openingOf(`land it`));
            const patches = fold.apply(kept);

            expect(fold.rows[0]).toEqual(expect.objectContaining({ role: `user`, text: `land it` }));
            expect(fold.ranNothing).toBe(false);
            expect(patches).toEqual([{ op: `append`, row: expect.objectContaining({ role: `notice` }) }]);
        });

        it(`offers to send it again, as the sandbox's to run rather than the composer's`, () => {
            const row = foldOf(`land it`, [kept]).at(-1);
            expect(row?.text).toBe(`${REFUSED.message} Nothing has run yet: the message above is kept here to send again once that is sorted.`);
            expect(row).toMatchObject({ noticeAction: `sendAgain`, sandboxHeld: true });
        });

        it(`offers the memory hold's own presses, anyway and the raise`, () => {
            const GIB = 1024 ** 3;
            const lowMemory = {
                kind: `error`,
                code: `sandbox-memory-low`,
                message: `Sandbox memory is low: 15.9 GiB of 16.0 GiB used.`,
                memory: { limitBytes: 16 * GIB, residentBytes: 15.9 * GIB, swapBytes: 0 },
                held: { ran: false },
            } as const satisfies AgentEvent;
            const row = foldOf(`land it`, [lowMemory]).at(-1);
            expect(row?.text).toBe(`${lowMemory.message} Nothing has run yet: the message above is kept here, and sending it anyway starts it.`);
            expect(row).toMatchObject({ noticeAction: `sandboxMemory`, sandboxHeld: true });
        });
    });

    // Asked by whoever keeps the words before the frame is folded, so it has to agree with the fold's own reading.
    describe(`turned away at the door`, () => {
        it(`is a refusal before anything was said, with somebody watching`, () => {
            const fold = new TranscriptFold(openingOf(`land it`));
            expect(fold.turnedAway(REFUSED)).toBe(true);
            expect(fold.turnedAway({ ...REFUSED, unattended: true })).toBe(false);
            expect(fold.turnedAway({ kind: `error`, code: `rate_limit`, message: `Usage limit reached.` })).toBe(false);
        });

        it(`is not a refusal that ended a turn which had already spoken`, () => {
            const fold = new TranscriptFold(openingOf(`land it`));
            fold.apply({ kind: `delta`, text: `on it` });
            expect(fold.turnedAway(REFUSED)).toBe(false);
        });
    });
});

// The sandbox's own notices ride as a code beside their English words, so an app can say them in the reader's language
// and words (sandbox-notice.ts). The words stay exactly as they were: older apps, stored records and agents read them.
describe(`the code beside a notice's words`, () => {
    const GIB = 1024 ** 3;
    const lowMemory = {
        kind: `error`,
        code: `sandbox-memory-low`,
        message: `Sandbox memory is low: 15.9 GiB of 16.0 GiB used.`,
        memory: { limitBytes: 16 * GIB, residentBytes: 15.9 * GIB, swapBytes: 0 },
    } as const satisfies AgentEvent;
    const lastOf = (events: readonly AgentEvent[]): TranscriptRow | undefined => foldOf(`land it`, events).at(-1);

    it(`names each land outcome, with the counts and repos its sentence was worded from`, () => {
        expect(lastOf([{ kind: `landed`, landed: true }])).toEqual({
            role: `notice`,
            text: `Changes landed in your workspace: review them in the Changes panel.`,
            noticeAction: `landHold`,
            noticeCode: { code: `landed` },
        });
        expect(lastOf([{ kind: `landed`, landed: true, deps: { missing: 2, started: [], deferred: true } }])?.noticeCode).toEqual({
            code: `landed`,
            params: { deps: 2, queued: true },
        });
        const conflicts = [
            { repo: `root`, paths: [{ path: `a.ts`, reason: `diverged` as const }], clean: 0 },
            { repo: `web`, paths: [{ path: `b.ts`, reason: `diverged` as const }, { path: `c.ts`, reason: `diverged` as const }], clean: 0 },
        ];
        expect(lastOf([{ kind: `landed`, landed: false, conflicts }])).toEqual({
            role: `notice`,
            text: `3 file(s) couldn't land automatically in root, web. Open the agent's review to see what blocked them and land from there.`,
            noticeCode: { code: `landConflict`, params: { files: 3, repos: `root, web` } },
        });
    });

    it(`names each memory hold by where the message waits`, () => {
        expect(lastOf([lowMemory])?.noticeCode).toEqual({ code: `memoryHeld`, params: { message: lowMemory.message, error: `sandbox-memory-low` } });
        expect(lastOf([{ ...lowMemory, held: { ran: false } }])?.noticeCode).toEqual({
            code: `kept`,
            params: { message: lowMemory.message, error: `sandbox-memory-low`, memory: true },
        });
        expect(lastOf([{ ...lowMemory, unattended: true }])?.noticeCode).toEqual({
            code: `undelivered`,
            params: { message: lowMemory.message, error: `sandbox-memory-low`, unattended: true },
        });
    });

    it(`codes a failure the sandbox names, and leaves a provider's own words to themselves`, () => {
        const busy = `This agent is already running a turn, wait for it to finish.`;
        expect(lastOf([{ kind: `error`, code: `agent-busy`, message: busy }])).toEqual({
            role: `notice`,
            text: busy,
            noticeCode: { code: `failed`, params: { message: busy, error: `agent-busy` } },
        });
        expect(lastOf([{ kind: `error`, message: `Overloaded.` }])).toEqual({ role: `notice`, text: `Overloaded.` });
        expect(lastOf([{ kind: `error`, code: `claude-token-refused`, message: `Token refused.` }])).toEqual({
            role: `notice`,
            text: `Token refused. Reconnect the account to pick this conversation back up.`,
            noticeCode: { code: `reconnect`, params: { message: `Token refused.`, error: `claude-token-refused` } },
        });
    });

    // A reader decodes a code with this build's own schema: every code the fold writes has to be one it knows.
    it(`writes only codes this build can read back`, () => {
        const events: AgentEvent[][] = [
            [{ kind: `worktree`, branch: `agent/x`, base: `abc1234`, sync: { commits: 1, blocked: [`web`] } }],
            [{ kind: `compact`, trigger: `auto` }],
            [{ kind: `landed`, landed: true, into: `p1` }],
            [{ kind: `landed`, landed: false, into: `p1`, conflicts: [] }],
            [{ kind: `landed`, landed: true, held: true }],
            [{ kind: `error`, code: `provider-outage`, message: `Down.`, autoResume: `available` }],
            [lowMemory],
            [{ ...lowMemory, held: { ran: false } }],
            [{ kind: `error`, code: `claude-token-refused`, message: `Token refused.`, autoResume: `scheduled` }, { kind: `error`, message: `401.` }],
        ];
        const rows = events.flatMap((turn) => foldTurn(openingOf(`go`), turn, `stopped`)).filter((row) => row.noticeCode !== undefined);
        expect(rows.filter((row) => sandboxNoticeOf(row) === undefined)).toEqual([]);
        expect(new Set(rows.map((row) => row.noticeCode?.code))).toEqual(
            new Set([`synced`, `compacted`, `intoParent`, `intoParentClash`, `landHeld`, `outageWaiting`, `memoryHeld`, `kept`, `renewalWithdrawn`, `stopped`]),
        );
    });

    // A newer sandbox's code must not cost an older app the whole page: the row parses, and the reader draws its words.
    it(`reads a row whose code this build does not know, and one written before rows carried codes`, () => {
        const newer: TranscriptRow = { role: `notice`, text: `Something new happened.`, noticeCode: { code: `somethingNew`, params: { count: 2 } } };
        expect(TranscriptRowSchema.parse(newer)).toEqual(newer);
        expect(sandboxNoticeOf(newer)).toBeUndefined();
        expect(TranscriptRowSchema.parse({ role: `notice`, text: `Stopped.` })).toEqual({ role: `notice`, text: `Stopped.` });
        expect(sandboxNoticeOf({ noticeCode: { code: `landConflict`, params: { files: `three` } } })).toBeUndefined();
    });
});
