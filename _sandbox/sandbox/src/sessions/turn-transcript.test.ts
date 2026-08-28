import { WORKSPACE_ROOT } from "@intentic/constants";
import { type AgentEvent, RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { withRuntimeHistory } from "../agent/runtime-history.js";
import { restoredTurn, subagentTurn } from "./turn-transcript.js";

// When the turn started: what its user row is stamped with (RestoredMessage.sentAt).
const SENT_AT = 1_767_225_600_000;

describe("restoredTurn", () => {
    it("opens with the user's own words, with the daemon's injections taken back out", () => {
        const prompt = "fix the build\n\nThe user attached these files: read them with the Read tool as needed:\n- /work/shot.png";
        expect(restoredTurn({ prompt }, [], "/work", SENT_AT)[0]).toEqual({
            role: "user",
            text: "fix the build",
            sentAt: SENT_AT,
            attachments: ["shot.png"],
        });
    });

    /* WHEN IT WAS SENT, not when its answer finished: the chat draws this on the bubble, and a stamp taken as
     * the turn settles would date a twenty-minute answer's question to twenty minutes after it was asked. Only
     * the user's row carries one: nothing in the frame log says when a given assistant block was written. */
    it("stamps the user's row with the turn's start and leaves the answer unstamped", () => {
        const events: AgentEvent[] = [{ kind: "delta", text: "on it" }];
        expect(restoredTurn({ prompt: "go" }, events, "/work", SENT_AT).map((message) => message.sentAt)).toEqual([SENT_AT, undefined]);
    });

    /* The handoff envelope is one of those injections. The conversation it carries is THIS record's own earlier
     * rows: the daemon read them out of it to seed the new session, so re-emitting them appended a second,
     * budget-truncated copy of the conversation on every provider or account switch, and a reopened chat showed
     * everything before the switch twice. */
    it("keeps only the typed prompt out of a handoff envelope, never the transcript folded into it", () => {
        const prompt = withRuntimeHistory("second", [
            { role: "user", text: "first" },
            { role: "assistant", text: "sure" },
        ]);
        expect(restoredTurn({ prompt }, [], "/work", SENT_AT)).toEqual([{ role: "user", text: "second", sentAt: SENT_AT }]);
    });

    /* A TURN THE DAEMON RE-RAN ITSELF. Its prompt is the user's words again behind a note explaining what killed
     * the first attempt, and recording that verbatim was two wrongs at once: a paragraph of machine prose filed
     * as something the user typed, directly under the copy of the message they really did type. What the record
     * wants there is the one thing neither copy says, which is why the answer below carries on at all. */
    it("records a re-run as the interruption that caused it, not as the message said twice", () => {
        const prompt = withResumeNote("ship the parser", RESUME_NOTES.auth);
        const events: AgentEvent[] = [{ kind: "delta", text: "picking back up" }];
        expect(restoredTurn({ prompt }, events, "/work", SENT_AT)).toEqual([
            { role: "notice", text: expect.stringContaining("sign-in renewed") },
            { role: "assistant", text: "picking back up" },
        ]);
    });

    /* The resume that carries NEW words: the daemon came back to a conversation parked on a card and this turn is
     * the answer. Nothing is dropped: it is the only copy of that answer there is, and the restart rides it as
     * the same collapsed note every other thing the daemon told a turn is disclosed as. */
    it("keeps a restored card's answer and carries the restart on it as a note", () => {
        const prompt = withResumeNote("the second option", RESUME_NOTES.answered);
        expect(restoredTurn({ prompt }, [], "/work", SENT_AT)).toEqual([
            {
                role: "user",
                text: "the second option",
                sentAt: SENT_AT,
                notes: [{ title: expect.any(String), text: RESUME_NOTES.answered }],
            },
        ]);
    });

    /* WHAT THE TURN WAS TOLD comes off its own frame log, not off any prompt. The notes never rode
     * `turn.prompt` (they were composed onto the request inside the run), so the old parse of that prompt found
     * nothing and every daemon-recorded turn silently lost them: the live tab drew the collapsed note rows and
     * the reopened tab drew none. The `preamble` frame is in the recorded events, and this fold keeps it. */
    it("records the notes the preamble frame carried, on the turn's user row", () => {
        const events: AgentEvent[] = [
            { kind: "preamble", notes: [{ title: "Map of this project", text: "## Map of this project\n\nthe workspace, 2 areas" }] },
            { kind: "delta", text: "on it" },
        ];
        expect(restoredTurn({ prompt: "fix the build" }, events, "/work", SENT_AT)[0]).toEqual({
            role: "user",
            text: "fix the build",
            sentAt: SENT_AT,
            notes: [{ title: "Map of this project", text: "## Map of this project\n\nthe workspace, 2 areas" }],
        });
    });

    // A re-run keeps both: the interruption notice replaces the repeated words, and a turn that was also told
    // something typed keeps that disclosure nowhere — the notice row carries no notes field to hang them on.
    it("records a re-run's interruption ahead of whatever the turn was told", () => {
        const prompt = withResumeNote("/work is where it lives", RESUME_NOTES.restart);
        expect(restoredTurn({ prompt }, [], "/work", SENT_AT)).toEqual([{ role: "notice", text: expect.stringContaining("sandbox came back") }]);
    });

    /* The live bubble boundary, matched to turnReducer's: `text_end` retires the block that WROTE something, so
     * the calls it introduced land in a fresh bubble under it, and the prose that reports them joins that same
     * bubble. This is Claude Code's interleaving: says what it's about to do → the cards → what it found, and
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
        expect(restoredTurn({ prompt: "look" }, events, "/work", SENT_AT).slice(1)).toEqual([
            { role: "assistant", text: "I'll look" },
            { role: "assistant", text: "found it", tools: [{ id: "t1", name: "Read", category: "read", status: "in_progress" }] },
            { role: "assistant", text: "and here's why" },
        ]);
    });

    /* THE USER SPOKE MID-TURN, and the record holds it, which it did not before the `steer` frame existed. The
     * message lived only in the window that sent it, so reopening the chat lost it entirely and the client's row
     * count ran one ahead of this one for the rest of the conversation (the count a fork copies a prefix of, and
     * the index a rewind addresses). It closes the open bubble for the same reason the live client retires its
     * own: what the agent says next is its answer to these words. */
    it("writes a mid-turn steer down as a user row, with the answer to it beneath", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "on it" },
            { kind: "steer", text: "and the tests", sentAt: SENT_AT + 1000, attachments: [".intentic/records/artifacts/attachments/u1/spec.md"] },
            { kind: "delta", text: "will do" },
        ];
        expect(restoredTurn({ prompt: "ship it" }, events, "/work", SENT_AT).slice(1)).toEqual([
            { role: "assistant", text: "on it" },
            {
                role: "user",
                text: "and the tests",
                sentAt: SENT_AT + 1000,
                attachments: [".intentic/records/artifacts/attachments/u1/spec.md"],
            },
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
        expect(restoredTurn({ prompt: "look" }, events, "/work", SENT_AT).slice(1)).toEqual([
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
        const [card] = restoredTurn({ prompt: "test" }, events, WORKSPACE_ROOT, SENT_AT).flatMap((message) => message.tools ?? []);
        expect(card).toEqual({
            id: "t1",
            name: "Bash",
            category: "execute",
            status: "failed",
            target: "pnpm test",
            content: [{ type: "text", text: "1 failed" }],
        });
    });

    // A card the turn died mid-call keeps `in_progress`: that is what happened, and claiming a completion it
    // never reported would be the one thing a restored transcript must not invent.
    it("leaves an unanswered call in progress", () => {
        const events: AgentEvent[] = [{ kind: "tool_call", id: "t1", name: "Bash", category: "execute", status: "in_progress" }];
        expect(restoredTurn({ prompt: "run" }, events, "/work", SENT_AT).at(-1)?.tools?.[0]?.status).toBe("in_progress");
    });

    /* A DELEGATION SURVIVES THE RELOAD. Its calls and its thinking nest under the Agent card that spawned them,
     * which is where the live client puts them, so a reopened chat redraws the delegation it was showing rather
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
        expect(restoredTurn({ prompt: "delegate" }, events, "/work", SENT_AT).at(-1)?.tools).toEqual([
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
    // there is nothing to hang the child off, which is exactly what keeps a nested level out of the level above.
    it("drops a subagent's frames when the card that spawned them is absent", () => {
        const events: AgentEvent[] = [
            { kind: "delta", text: "delegating" },
            { kind: "tool_call", id: "t2", name: "Read", category: "read", status: "completed", parentToolUseId: "task-1" },
        ];
        expect(restoredTurn({ prompt: "delegate" }, events, "/work", SENT_AT).slice(1)).toEqual([{ role: "assistant", text: "delegating" }]);
    });

    // One subagent's own side of the same log: what the Subagents area renders while it runs. Read at the
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
        expect(restoredTurn({ prompt: "think" }, events, "/work", SENT_AT).at(-1)).toEqual({ role: "assistant", text: "yes", thinking: "hm, maybe" });
    });

    // Frames that are not transcript (usage, todos, the interactive cards, the settle) carry no bubble of
    // their own, so a turn that only emitted those restores as the prompt alone rather than an empty reply.
    it("yields nothing but the prompt for a turn that said nothing", () => {
        const events: AgentEvent[] = [{ kind: "init", model: "claude-opus-4" }, { kind: "usage", costUsd: 0.1 }, { kind: "done" }];
        expect(restoredTurn({ prompt: "hi" }, events, "/work", SENT_AT)).toEqual([{ role: "user", text: "hi", sentAt: SENT_AT }]);
    });

    /* A REFUSED TURN SAYS SO WHEN IT IS REOPENED. The provider's answer to this one is an error frame and no
     * prose at all, so folding only the two speakers left a question with no reply under it, which is how a
     * workflow step whose model was refused came to read as a broken session on every surface. */
    it("keeps what went wrong, as the notice line the turn ended on", () => {
        const refusal = "Your organization has disabled Claude subscription access for Claude Code";
        const events: AgentEvent[] = [{ kind: "delta", text: "I'll take a look" }, { kind: "error", message: refusal }, { kind: "done" }];
        expect(restoredTurn({ prompt: "hi" }, events, "/work", SENT_AT)).toEqual([
            { role: "user", text: "hi", sentAt: SENT_AT },
            { role: "assistant", text: "I'll take a look" },
            { role: "notice", text: refusal },
        ]);
    });

    /* AND SO DOES A TURN THAT RAN CHEAPER THAN THE MODEL ASKED FOR. Same argument as the refusal above: the
     * live chat says it as it happens, and without a row here that sentence belonged to whoever had the tab
     * open at the time. Scrolling back a week later, "was THIS answer the cheap one" is the question, and only
     * a row per routed turn can answer it. The offer rides along so the reopened line keeps its one press. */
    it("writes down a turn that ran on a cheaper model, with the opt-out it was offered live", () => {
        const events: AgentEvent[] = [
            { kind: "tier", tier: "fast", score: 0.1, rules: ["easy-words"], model: "claude-haiku-4-5", routed: true },
            { kind: "delta", text: "a closure is…" },
        ];
        expect(restoredTurn({ prompt: "what is a closure?" }, events, "/work", SENT_AT)).toEqual([
            { role: "user", text: "what is a closure?", sentAt: SENT_AT },
            { role: "notice", text: "This turn looked simple, so it ran on claude-haiku-4-5 instead of your pick.", noticeAction: "tierHold" },
            { role: "assistant", text: "a closure is…" },
        ]);
    });

    it("says nothing about a verdict that moved nothing, which is most of them", () => {
        /* Measuring, a held chat, a provider with nothing cheaper: all three judge the turn and all three run
         * the user's own model. A row apiece would bury the conversation under instrumentation about turns
         * where nothing happened. */
        const judged: AgentEvent[] = [
            { kind: "tier", tier: "fast", score: 0.1, rules: ["easy-words"], routed: false },
            { kind: "delta", text: "sure" },
        ];
        const held: AgentEvent[] = [
            { kind: "tier", tier: "fast", score: 0.1, rules: ["easy-words"], model: "claude-haiku-4-5", routed: false, held: true },
            { kind: "delta", text: "sure" },
        ];
        for (const events of [judged, held]) {
            expect(restoredTurn({ prompt: "go" }, events, "/work", SENT_AT).map((message) => message.role)).toEqual(["user", "assistant"]);
        }
    });
});
