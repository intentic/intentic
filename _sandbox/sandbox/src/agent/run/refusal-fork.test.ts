import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { isSafeguardRefusal, RefusalFork } from "./refusal-fork.js";

// The stream a real Claude CLI (2.1.283) sent for a turn whose second and third requests the classifier stopped: one
// good response and its tool result, a stopped response and the CLI's own retry of it, stopped again. Uuids are the
// session transcript's chain ids; only the shapes the fork reads are filled in.

// SAFETY: the fork reads only type, subtype, uuid, parent_tool_use_id, error and message.{id, stop_reason, stop_details,
// content}, and every fixture below fills those as the real CLI sent them.
const sdk = (message: object): SDKMessage => message as SDKMessage;
const assistant = (uuid: string, response: string, parent: string | null = null): SDKMessage =>
    sdk({ type: "assistant", uuid, parent_tool_use_id: parent, message: { id: response, stop_reason: null, content: [{ type: "text", text: "…" }] } });
const user = (uuid: string, parent: string | null = null): SDKMessage =>
    sdk({ type: "user", uuid, parent_tool_use_id: parent, message: { role: "user", content: [] } });
const retried = sdk({
    type: "system",
    subtype: "informational",
    content: "Opus 5.5's safeguards stopped the response above · continuing once with that noted",
});
const noFallback = (prompt: string | null): SDKMessage =>
    sdk({ type: "system", subtype: "model_refusal_no_fallback", api_refusal_category: "cyber", refused_user_message_uuid: prompt });
const refusalDetails = (category: string | undefined): object =>
    category === undefined ? {} : { stop_details: { type: "refusal", category, explanation: "blocked" } };
const flag = (text: string, stop: string | null = "refusal", category?: string): SDKMessage =>
    sdk({
        type: "assistant",
        uuid: "synthetic",
        parent_tool_use_id: null,
        error: "invalid_request",
        message: { id: "b889eeb7", stop_reason: stop, content: [{ type: "text", text }], ...refusalDetails(category) },
    });
const FLAG_TEXT = "API Error: Opus 5.5's safeguards flagged this session (https://www.anthropic.com/legal/aup).";

const fed = (messages: readonly SDKMessage[]): RefusalFork => {
    const fork = new RefusalFork();
    for (const message of messages) {
        fork.note(message);
    }
    return fork;
};

test("resumes at the good tool result, before the stopped response and the CLI's own retry of it", () => {
    const fork = fed([
        assistant("good-text", "msg_1"),
        assistant("good-call", "msg_1"),
        user("good-result"),
        assistant("stopped-text", "msg_2"),
        assistant("stopped-call", "msg_2"),
        user("not-run"),
        retried,
        user("nudge"),
        assistant("stopped-again-text", "msg_3"),
        assistant("stopped-again-call", "msg_3"),
        noFallback("prompt"),
        flag(FLAG_TEXT, "refusal", "cyber"),
    ]);
    expect(fork.point()).toStrictEqual({ category: "cyber", resumeAt: "good-result" });
});

test("a response the classifier let through after a stopped one keeps the stopped one: only the closing run is cut", () => {
    const fork = fed([
        user("good-result"),
        assistant("stopped", "msg_2"),
        retried,
        user("nudge"),
        assistant("recovered", "msg_3"),
        user("recovered-result"),
        assistant("stopped-late", "msg_4"),
        noFallback("prompt"),
    ]);
    expect(fork.point()).toStrictEqual({ category: "cyber", resumeAt: "recovered-result" });
});

test("stopped on the turn's first response, resumes at the person's message the CLI names", () => {
    expect(fed([assistant("stopped", "msg_1"), noFallback("prompt"), flag(FLAG_TEXT)]).point()).toStrictEqual({ category: "cyber", resumeAt: "prompt" });
    // Naming none leaves no point, and the retry resumes the session whole.
    expect(fed([assistant("stopped", "msg_1"), noFallback(null)]).point()).toStrictEqual({ category: "cyber" });
});

test("a subagent's messages are not the session a retry resumes", () => {
    const fork = fed([user("good-result"), assistant("child", "msg_c", "toolu_task"), user("child-result", "toolu_task"), assistant("stopped", "msg_2"), noFallback(null)]);
    expect(fork.point()).toStrictEqual({ category: "cyber", resumeAt: "good-result" });
});

test("nothing marked stopped (a CLI that said it only in prose) names no point", () => {
    expect(fed([user("good-result"), assistant("answer", "msg_2")]).point()).toStrictEqual({});
});

test("the flag is read from the structured stop reason, else from the CLI's sentence", () => {
    const flagged = (message: SDKMessage): boolean => message.type === "assistant" && isSafeguardRefusal(message);
    expect(flagged(flag("anything"))).toBe(true);
    expect(flagged(flag(FLAG_TEXT, null))).toBe(true);
    expect(flagged(flag("API Error: 500 Internal server error", null))).toBe(false);
    // A response, not an error: never the flag, whatever it says.
    expect(flagged(assistant("u", "msg_1"))).toBe(false);
});
