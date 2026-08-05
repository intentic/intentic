import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { withRuntimeHistory } from "../agent/runtime-history.js";
import { restoredTurn, subagentTurn } from "./turn-transcript.js";

describe("restoredTurn", () => {
    it("opens with the user's own words, with the daemon's injections taken back out", () => {
        const prompt = "fix the build\n\nThe user attached these files — read them with the Read tool as needed:\n- /work/shot.png";
        expect(restoredTurn({ prompt }, [], "/work")[0]).toEqual({ role: "user", text: "fix the build", attachments: ["shot.png"] });
    });

    /* The handoff envelope is one of those injections. The conversation it carries is THIS record's own earlier
     * rows — the daemon read them out of it to seed the new session — so re-emitting them appended a second,
     * budget-truncated copy of the conversation on every provider or account switch, and a reopened chat showed
     * everything before the switch twice. */
    it("keeps only the typed prompt out of a handoff envelope, never the transcript folded into it", () => {
        const prompt = withRuntimeHistory("second", [
            { role: "user", text: "first" },
            { role: "assistant", text: "sure" },
        ]);
        expect(restoredTurn({ prompt }, [], "/work")).toEqual([{ role: "user", text: "second" }]);
    });

    /* The live bubble boundary, matched to turnReducer's: `text_end` retires the block that WROTE something, so
     * the calls it introduced land in a fresh bubble under it, and the prose that reports them joins that same
     * bubble. This is Claude Code's interleaving — says what it's about to do → the cards → what it found — and
     * it has to come back the way it was watched, not re-grouped. */
    it("retires a prose bubble at text_end so the calls it introduced land beneath it", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "I'll look" },
            { kind: "text_end" },
            { kind: "tool_call", id: "t1", name: "Read", category: "read", status: "in_progress" },
            { kind: "delta", text: "found it" },
            { kind: "text_end" },
            { kind: "delta", text: "and here's why" },
        ];
        expect(restoredTurn({ prompt: "look" }, events, "/work").slice(1)).toEqual([
            { role: "assistant", text: "I'll look" },
            { role: "assistant", text: "found it", tools: [{ id: "t1", name: "Read", category: "read", status: "in_progress" }] },
            { role: "assistant", text: "and here's why" },
        ]);
    });

    // A text_end on a bubble holding only cards is not a boundary — retiring there would split a card away from
    // the prose that reports it, a shape the live stream never draws.
    it("does not retire a bubble that has written no prose", () => {
        const events: AgentEvent[] = [
            { kind: "tool_call", id: "t1", name: "Read", category: "read", status: "completed" },
            { kind: "text_end" },
            { kind: "delta", text: "that's the file" },
        ];
        expect(restoredTurn({ prompt: "look" }, events, "/work").slice(1)).toEqual([
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
        const [card] = restoredTurn({ prompt: "test" }, events, "/work").flatMap((message) => message.tools ?? []);
        expect(card).toEqual({
            id: "t1",
            name: "Bash",
            category: "execute",
            status: "failed",
            target: "pnpm test",
            content: [{ type: "text", text: "1 failed" }],
        });
    });

    // A card the turn died mid-call keeps `in_progress` — that is what happened, and claiming a completion it
    // never reported would be the one thing a restored transcript must not invent.
    it("leaves an unanswered call in progress", () => {
        const events: AgentEvent[] = [{ kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress" }];
        expect(restoredTurn({ prompt: "run" }, events, "/work").at(-1)?.tools?.[0]?.status).toBe("in_progress");
    });

    /* A DELEGATION SURVIVES THE RELOAD. Its calls and its thinking nest under the Agent card that spawned them,
     * which is where the live client puts them — so a reopened chat redraws the delegation it was showing rather
     * than a leaf card. Its PROSE stays off the card: that card has nowhere to render prose, and the child's
     * report already arrives as the card's own result content. */
    it("nests a subagent's calls and thinking under the card that spawned them", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "delegating" },
            { kind: "tool_call", id: "task-1", name: "Agent", category: "other", status: "in_progress" },
            { kind: "delta", text: "inner voice", parentToolUseId: "task-1" },
            { kind: "thinking", text: "hmm", parentToolUseId: "task-1" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "in_progress", parentToolUseId: "task-1" },
            { kind: "tool_call_update", id: "t2", status: "completed" },
        ];
        expect(restoredTurn({ prompt: "delegate" }, events, "/work").at(-1)?.tools).toEqual([
            {
                id: "task-1",
                name: "Agent",
                category: "other",
                status: "in_progress",
                thinking: "hmm",
                children: [{ id: "t2", name: "Read", category: "read", status: "completed" }],
            },
        ]);
    });

    // Its Agent card is not in this stream (a malformed log, or one level of a deeper spawn read on its own), so
    // there is nothing to hang the child off — which is exactly what keeps a nested level out of the level above.
    it("drops a subagent's frames when the card that spawned them is absent", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "delegating" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "completed", parentToolUseId: "task-1" },
        ];
        expect(restoredTurn({ prompt: "delegate" }, events, "/work").slice(1)).toEqual([{ role: "assistant", text: "delegating" }]);
    });

    // One subagent's own side of the same log — what the Subagents area renders while it runs. Read at the
    // child's level its prose IS top-level, and the parent's frames are not its business.
    it("reads one subagent's stream as a transcript of its own", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "parent prose" },
            { kind: "tool_call", id: "t1", name: "Grep", category: "search", status: "completed" },
            { kind: "delta", text: "found it", parentToolUseId: "task-1" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "completed", parentToolUseId: "task-1" },
        ];
        expect(subagentTurn(events, "task-1", "Locate claimIndexer")).toEqual([
            { role: "user", text: "Locate claimIndexer" },
            { role: "assistant", text: "found it", tools: [{ id: "t2", name: "Read", category: "read", status: "completed" }] },
        ]);
    });

    it("records the thinking a turn showed", () => {
        const events: AgentEvent[] = [
            { kind: "thinking", text: "hm, " },
            { kind: "thinking", text: "maybe" },
            { kind: "delta", text: "yes" },
        ];
        expect(restoredTurn({ prompt: "think" }, events, "/work").at(-1)).toEqual({ role: "assistant", text: "yes", thinking: "hm, maybe" });
    });

    // Frames that are not transcript — usage, todos, the interactive cards, the settle — carry no bubble of
    // their own, so a turn that only emitted those restores as the prompt alone rather than an empty reply.
    it("yields nothing but the prompt for a turn that said nothing", () => {
        const events: AgentEvent[] = [{ kind: "init", model: "claude-opus-4" }, { kind: "usage", costUsd: 0.1 }, { kind: "done" }];
        expect(restoredTurn({ prompt: "hi" }, events, "/work")).toEqual([{ role: "user", text: "hi" }]);
    });

    /* A REFUSED TURN SAYS SO WHEN IT IS REOPENED. The provider's answer to this one is an error frame and no
     * prose at all, so folding only the two speakers left a question with no reply under it — which is how a
     * workflow step whose model was refused came to read as a broken session on every surface. */
    it("keeps what went wrong, as the notice line the turn ended on", () => {
        const refusal = "Your organization has disabled Claude subscription access for Claude Code";
        const events: AgentEvent[] = [{ kind: "delta", text: "I'll take a look" }, { kind: "error", message: refusal }, { kind: "done" }];
        expect(restoredTurn({ prompt: "hi" }, events, "/work")).toEqual([
            { role: "user", text: "hi" },
            { role: "assistant", text: "I'll take a look" },
            { role: "notice", text: refusal },
        ]);
    });
});
