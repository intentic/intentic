import type { AgentEvent } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { restoredTurn } from "./turn-transcript.js";

describe("restoredTurn", () => {
    it("opens with the user's own words, with the daemon's injections taken back out", () => {
        const prompt = "fix the build\n\nThe user attached these files — read them with the Read tool as needed:\n- /work/shot.png";
        expect(restoredTurn({ prompt }, [], "/work")[0]).toEqual({ role: "user", text: "fix the build", attachments: ["shot.png"] });
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

    it("keeps a subagent's inner stream out of the flat transcript", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "delegating" },
            { kind: "delta", text: "inner voice", parentToolUseId: "task-1" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "completed", parentToolUseId: "task-1" },
        ];
        expect(restoredTurn({ prompt: "delegate" }, events, "/work").slice(1)).toEqual([{ role: "assistant", text: "delegating" }]);
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
});
