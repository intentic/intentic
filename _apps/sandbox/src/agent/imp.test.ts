import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { AgentRequest, QueryFn } from "./agent.js";
import { SteeringQueue } from "./agent-steering.js";
import { runImpMode } from "./imp.js";

/* Imp mode drives TWO SDK sessions per round — a tool-less architect and then its imp — so the fake query here
 * answers per call, and the model id is what tells the halves apart (the imp runs on the cheap model). Each
 * entry is one canned session; the recorded (prompt, options) pairs are how the split itself is asserted. */

interface Call {
    readonly prompt: string;
    readonly options: Options;
}

const scripted =
    (sessions: readonly (readonly unknown[])[], calls: Call[]): QueryFn =>
    (args): AsyncGenerator<SDKMessage> => {
        const index = calls.length;
        calls.push({ prompt: typeof args.prompt === "string" ? args.prompt : "", options: args.options });
        const messages = sessions[index] ?? [];
        return (async function* () {
            for (const message of messages) {
                yield message as SDKMessage;
            }
        })();
    };

const text = (session: string, value: string): unknown => ({
    type: "stream_event",
    session_id: session,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: value } },
});
const toolUse = (session: string, id: string, name: string, input: unknown): unknown => ({
    type: "assistant",
    session_id: session,
    message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (session: string, usage?: Record<string, number>): unknown => ({
    type: "result",
    subtype: "success",
    session_id: session,
    result: "ok",
    ...(usage !== undefined ? { usage: { input_tokens: usage["input"], output_tokens: usage["output"] }, total_cost_usd: usage["cost"] } : {}),
    modelUsage: {},
});
// The canned imp that finds nothing to do — no tool calls, which is what ends a turn.
const IDLE_IMP = [text("imp", "NOTHING TO DO"), result("imp")];

const request = { prompt: "make /ping work", cwd: "/work", signal: new AbortController().signal, model: "opus" };
const imp = { model: "haiku" };

const collect = async (queryFn: QueryFn, turn: AgentRequest = request): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of runImpMode(imp, turn, queryFn)) {
        events.push(event);
    }
    return events;
};

test("one imp per round: the architect's whole message goes over at once, and its report opens the next round", async () => {
    const calls: Call[] = [];
    const events = await collect(
        scripted(
            [
                // A multi-paragraph round. All of it is ONE dispatch — an imp fired at the first paragraph would
                // be acting on a statement of intent while the paragraph that says what is actually wanted is
                // still being written, and would then race the imp that gets the rest.
                [
                    text("arch", "I need to see how routes are wired.\n\n"),
                    text("arch", "Specifically what src/app.ts registers, and whether /ping already exists."),
                    result("arch"),
                ],
                [
                    toolUse("imp", "t1", "Read", { file_path: "/work/src/app.ts" }),
                    text("imp", "src/app.ts:12 registers routes via app.route(); no /ping."),
                    result("imp"),
                ],
                // Round 2: the answer, asking for nothing more.
                [text("arch", "Routes are registered at src/app.ts:12 — nothing else to do."), result("arch")],
                IDLE_IMP,
            ],
            calls,
        ),
    );

    // The architect's text is the turn's text; the imp's is not (it rides its card instead).
    expect(events.filter((event) => event.kind === "delta").map((event) => event.text)).toEqual([
        "I need to see how routes are wired.\n\n",
        "Specifically what src/app.ts registers, and whether /ping already exists.",
        "Routes are registered at src/app.ts:12 — nothing else to do.",
    ]);
    // Each round's dispatch is a card, and the imp's own calls hang under it.
    expect(events.find((event) => event.kind === "tool_call" && event.name === "Imp")).toMatchObject({
        kind: "tool_call",
        id: "imp_1",
        target: "I need to see how routes are wired.",
    });
    expect(events.find((event) => event.kind === "tool_call" && event.name === "Read")).toMatchObject({ parentToolUseId: "imp_1" });
    expect(events.find((event) => event.kind === "tool_call_update" && event.id === "imp_1")).toMatchObject({
        status: "completed",
        content: [{ type: "text", text: "src/app.ts:12 registers routes via app.route(); no /ping." }],
    });
    // Two rounds, one dispatch each, one terminal `done` for the whole turn.
    expect(calls).toHaveLength(4);
    expect(events.filter((event) => event.kind === "done")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ kind: "done" });

    // The architect is tool-less and its imp holds the tools; the imp never gets the ask tool.
    expect(calls[0]?.options.tools).toEqual(["EnterPlanMode", "ExitPlanMode"]);
    expect(calls[0]?.options.model).toBe("opus");
    expect(calls[1]?.options.model).toBe("haiku");
    expect(calls[1]?.options.tools).toBeUndefined();
    expect(calls[1]?.options.disallowedTools).toEqual(["EnterPlanMode", "ExitPlanMode"]);
    expect(Object.keys(calls[1]?.options.mcpServers ?? {})).toEqual([]);
    expect(Object.keys(calls[0]?.options.mcpServers ?? {})).toEqual(["ui"]);

    // The dispatch sees the architect's paragraphs together, and carries the user's request for context.
    expect(calls[1]?.prompt).toContain("make /ping work");
    expect(calls[1]?.prompt).toContain("I need to see how routes are wired.");
    expect(calls[1]?.prompt).toContain("whether /ping already exists");
    // The second round's architect prompt is the report.
    expect(calls[2]?.prompt).toContain("Your imp did this and reported back");
    expect(calls[2]?.prompt).toContain("src/app.ts:12 registers routes via app.route()");
});

test("an imp never asks the user for permission, whatever posture the turn is in", async () => {
    const calls: Call[] = [];
    // A card raised by a dispatch would park the turn on a question with no context, one per command, with the
    // architect waiting behind it — so an imp runs unprompted even when the user chose a gated mode.
    await collect(scripted([[text("arch", "Show me how routes are wired."), result("arch")], IDLE_IMP], calls), {
        ...request,
        permissionMode: "default" as const,
    });
    expect(calls[0]?.options.permissionMode).toBe("default");
    expect(calls[1]?.options.permissionMode).toBe("bypassPermissions");
    expect(calls[1]?.options.allowDangerouslySkipPermissions).toBe(true);
});

test("plan mode withholds the editing tools from the imp until the user approves", async () => {
    const calls: Call[] = [];
    const events = await collect(
        scripted(
            [
                [text("arch", "Let me see how routes are wired."), result("arch")],
                [toolUse("imp", "t1", "Read", { file_path: "/work/src/app.ts" }), text("imp", "read it"), result("imp")],
                // Round 2: the SDK reports the post-approval posture, then the architect states the change.
                [
                    { type: "system", subtype: "status", session_id: "arch", permissionMode: "acceptEdits" },
                    text("arch", "Add a /ping route to src/app.ts."),
                    result("arch"),
                ],
                [
                    toolUse("imp", "t2", "Edit", { file_path: "/work/src/app.ts", old_string: "a", new_string: "b" }),
                    text("imp", "edited"),
                    result("imp"),
                ],
                [text("arch", "Done."), result("arch")],
                IDLE_IMP,
            ],
            calls,
        ),
        { ...request, permissionMode: "plan" as const },
    );
    expect(events.some((event) => event.kind === "mode" && event.mode === "acceptEdits")).toBe(true);
    // While planning: unprompted, but unable to edit, and told so.
    expect(calls[1]?.options.permissionMode).toBe("bypassPermissions");
    expect(calls[1]?.options.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]));
    expect(calls[1]?.prompt).toContain("investigate and report only");
    // After the approval: the editing tools are back.
    expect(calls[3]?.options.disallowedTools).not.toEqual(expect.arrayContaining(["Edit"]));
    expect(calls[3]?.prompt).not.toContain("investigate and report only");
});

test("each half's spend is its own frame, and the architect's lands before its imp starts", async () => {
    const calls: Call[] = [];
    const events = await collect(
        scripted(
            [
                [text("arch", "Show me src/app.ts."), result("arch", { input: 100, output: 20, cost: 0.01 })],
                [
                    toolUse("imp", "t1", "Read", { file_path: "/work/src/app.ts" }),
                    text("imp", "seen"),
                    result("imp", { input: 40, output: 5, cost: 0.001 }),
                ],
                [text("arch", "Done."), result("arch", { input: 130, output: 10, cost: 0.012 })],
                [text("imp", "NOTHING TO DO"), result("imp", { input: 20, output: 2, cost: 0.0004 })],
            ],
            calls,
        ),
    );
    // One frame per half per round, attributed rather than merged — you can see what each half cost.
    const usage = events.filter((event) => event.kind === "usage");
    expect(usage).toHaveLength(4);
    expect(usage.map((event) => event.inputTokens)).toEqual([100, 40, 130, 20]);

    // THE ORDERING CLAIM. A client renders one assistant message as thinking → tools → text, so an imp card
    // that shares the architect's bubble is drawn ABOVE the message that caused it. The architect's usage frame
    // is what closes that bubble, so it has to be on the wire BEFORE the imp's card, or the transcript reads
    // backwards: work first, request for it second.
    const kinds = events.map((event) => (event.kind === "tool_call" && event.name === "Imp" ? "imp-card" : event.kind));
    expect(kinds.indexOf("usage")).toBeLessThan(kinds.indexOf("imp-card"));
    expect(kinds.lastIndexOf("delta")).toBeGreaterThan(kinds.indexOf("imp-card"));
});

test("every dispatch starts a fresh session, so an imp's history is never re-sent", async () => {
    const calls: Call[] = [];
    await collect(
        scripted(
            [
                [text("arch", "Show me how routes are wired."), result("arch")],
                [toolUse("imp", "t1", "Read", { file_path: "/work/src/app.ts" }), text("imp", "read it"), result("imp")],
                [text("arch", "Now write it down."), result("arch")],
                [toolUse("imp", "t2", "Write", { file_path: "/work/notes.md" }), text("imp", "written"), result("imp")],
                [text("arch", "Done."), result("arch")],
                IDLE_IMP,
            ],
            calls,
        ),
    );
    // Resuming one imp session across a turn made every later dispatch re-send everything the imp had already
    // read: a measured run spent 361k of context — half the turn — replaying history to emit 502 tokens.
    expect(calls[1]?.options.resume).toBeUndefined();
    expect(calls[3]?.options.resume).toBeUndefined();
    expect(calls[5]?.options.resume).toBeUndefined();
    // The architect, by contrast, IS the memory: its rounds resume the conversation's own session.
    expect(calls[2]?.options.resume).toBe("arch");
    expect(calls[4]?.options.resume).toBe("arch");
});

test("a dispatch that finds nothing to do leaves no card behind", async () => {
    // Every turn ends with one of these — it is how the loop learns it is over — so carding it would put a
    // "NOTHING TO DO" tile at the end of every transcript, reading as a failure rather than as termination.
    const calls: Call[] = [];
    const events = await collect(scripted([[text("arch", "Nothing needs changing."), result("arch")], IDLE_IMP], calls));
    expect(events.some((event) => event.kind === "tool_call" && event.name === "Imp")).toBe(false);
    expect(events.filter((event) => event.kind === "delta").map((event) => event.text)).toEqual(["Nothing needs changing."]);
});

test("a dispatch that fails tells the architect, instead of letting it believe the work happened", async () => {
    const calls: Call[] = [];
    const events = await collect(
        scripted(
            [
                [text("arch", "Read src/app.ts."), result("arch")],
                // The imp dies before it runs anything: no report, and nothing else would ever tell the architect.
                [{ type: "assistant", session_id: "imp", message: { content: [] }, error: "overloaded" }, result("imp")],
                [text("arch", "Then I'll work from what I have."), result("arch")],
                IDLE_IMP,
            ],
            calls,
        ),
    );
    // The failure is surfaced to the user AND carried into the architect's next message.
    expect(events.some((event) => event.kind === "error")).toBe(true);
    expect(calls[2]?.prompt).toContain("Your imp FAILED");
    // A failed dispatch that ran no tools still opens the next round — the architect gets to adapt.
    expect(calls).toHaveLength(4);
});

test("an imp that runs no tools ends the turn after one round", async () => {
    const calls: Call[] = [];
    await collect(scripted([[text("arch", "Nothing here needs changing."), result("arch")], IDLE_IMP], calls));
    expect(calls).toHaveLength(2);
});

test("a message steered mid-turn opens the next round even when the imp found nothing to do", async () => {
    const calls: Call[] = [];
    const steering = new SteeringQueue();
    const events: AgentEvent[] = [];
    const queryFn = scripted(
        [
            [text("arch", "Nothing needs doing."), result("arch")],
            IDLE_IMP,
            [text("arch", "Right — checking the tests then."), result("arch")],
            IDLE_IMP,
        ],
        calls,
    );
    let steered = false;
    for await (const event of runImpMode(imp, { ...request, steering }, queryFn)) {
        // Steer once, while the architect's first round is on the wire — exactly what /agent/steer does mid-turn.
        if (event.kind === "delta" && !steered) {
            steered = true;
            steering.push("also check the tests");
        }
        events.push(event);
    }
    expect(calls).toHaveLength(4);
    expect(calls[2]?.prompt).toContain("The user says: also check the tests");
    expect(events.at(-1)).toEqual({ kind: "done" });
});
