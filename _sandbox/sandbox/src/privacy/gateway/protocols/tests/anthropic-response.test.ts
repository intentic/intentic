import { restoreResponse, restoreStream } from "../index.js";
import { isText, type JsonObject, parseJson } from "../walk.js";
import { at, restore } from "./fake-shield.testing.js";
import { parseWire, payloads, runEverySplit, runText, sse } from "./stream.testing.js";

// What Claude Code receives must name real people again, in its text and in the tool calls it runs; what it must send
// back exactly (signed thinking) must arrive exactly as the provider wrote it.

const ADDRESS = 'ul. "Długa" 5\n00-001 Warszawa';
const SIGNATURE = "EqQBCkYIBxgCKkDo2mN0Z3Rva2VuLXNpZ25hdHVyZQ==";

describe("restoring an Anthropic Messages response", () => {
    test("text and tool inputs are restored, thinking is not", () => {
        const thinking = { type: "thinking", thinking: "⟦PERSON_1⟧ wants mail", signature: SIGNATURE };
        const body = {
            id: "msg_01XFDUDYJgAACzvnptvVoYEL",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            content: [
                thinking,
                { type: "text", text: "Writing to ⟦PERSON_1⟧ at [[EMAIL_1]]." },
                {
                    type: "tool_use",
                    id: "toolu_01",
                    name: "Bash",
                    input: { command: "mail ⟦EMAIL_1⟧", nested: { to: ["⟦PERSON_2⟧"] }, "⟦PERSON_1⟧": 1 },
                },
                { type: "server_tool_use", id: "srvtoolu_01", name: "web_search", input: { query: "⟦PERSON_1⟧" } },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 20 },
        };
        const restored = restoreResponse("anthropic", body, restore);
        expect(at(restored, "content", 0)).toBe(thinking);
        expect(at(restored, "content", 1)).toEqual({ type: "text", text: "Writing to Jan Kowalski at jan.kowalski@example.pl." });
        expect(at(restored, "content", 2, "input")).toEqual({
            command: "mail jan.kowalski@example.pl",
            nested: { to: ["Zażółć Gęślą"] },
            "⟦PERSON_1⟧": 1,
        });
        expect(at(restored, "content", 3, "input")).toEqual({ query: "Jan Kowalski" });
        expect(at(restored, "usage")).toBe(body.usage);
    });

    test("an error or a token count passes as it came", () => {
        const error = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
        expect(restoreResponse("anthropic", error, restore)).toBe(error);
        const count = { input_tokens: 2095 };
        expect(restoreResponse("anthropic", count, restore)).toBe(count);
    });
});

// A Claude Code turn as the API streams it: thinking, then text whose tokens and multibyte letters land across
// deltas, then a tool call whose JSON is cut mid-token, with a ping and an event type from the future along the way.
const TEXT_DELTAS = ["Napiszę do ⟦PERS", "ON_1⟧ (", "⟦EMAIL_1", "⟧) — zażółć 🎉 ", "[[PERSON_2]", "] i ⟦ADDRESS_1⟧ gotowe ⟦PER"];
const TOOL_FRAGMENTS = ["", '{"command": "echo ', "⟦PERSON", '_1⟧ > /tmp/a", "description": "Write ⟦ADDR', 'ESS_1⟧", "count": 12345678901234567890}'];
const UNKNOWN = { type: "content_block_future", index: 1, note: "⟦PERSON_1⟧" };

const claudeCodeStream = (newline = "\n"): string =>
    sse(
        [
            [
                "message_start",
                {
                    type: "message_start",
                    message: {
                        id: "msg_01",
                        type: "message",
                        role: "assistant",
                        model: "claude-sonnet-4-5-20250929",
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: {
                            input_tokens: 2,
                            cache_creation_input_tokens: 1520,
                            cache_read_input_tokens: 13_024,
                            output_tokens: 1,
                            service_tier: "standard",
                        },
                    },
                },
            ],
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
            ["ping", { type: "ping" }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "The user is ⟦PERS" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ON_1⟧." } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: SIGNATURE } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
            ...TEXT_DELTAS.map(
                (text) => ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text } }] as const,
            ),
            ["content_block_future", UNKNOWN],
            ["content_block_stop", { type: "content_block_stop", index: 1 }],
            [
                "content_block_start",
                { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_01", name: "Bash", input: {} } },
            ],
            ...TOOL_FRAGMENTS.map(
                (partial_json) =>
                    ["content_block_delta", { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json } }] as const,
            ),
            ["content_block_stop", { type: "content_block_stop", index: 2 }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 120 } }],
            ["message_stop", { type: "message_stop" }],
        ],
        newline,
    );

const deltasOf = (events: readonly JsonObject[], index: number, type: string, field: string): readonly string[] =>
    events.flatMap((event) => {
        const value = at(event, "delta", field);
        return event["type"] === "content_block_delta" && event["index"] === index && at(event, "delta", "type") === type && isText(value)
            ? [value]
            : [];
    });

// Events this never rewrites, as the exact text they must be forwarded as.
const UNTOUCHED_EVENTS = [
    'event: ping\ndata: {"type":"ping"}\n\n',
    `event: content_block_future\ndata: ${JSON.stringify(UNKNOWN)}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

// What a client makes of the stream: the text it assembles, the tool input fragments it parses, the thinking it must
// send back, and whether everything arrived in an order it accepts.
const turnOf = (output: string): JsonObject => {
    const events = payloads(output);
    const order = events.map((event) => `${String(event["type"])}:${String(event["index"] ?? "")}`);
    const tool = deltasOf(events, 2, "input_json_delta", "partial_json");
    return {
        text: deltasOf(events, 1, "text_delta", "text").join(""),
        tool,
        // What the harness's tool receives once it parses the fragment.
        toolInput: [at(parseJson(tool[0] ?? ""), "command") ?? null, at(parseJson(tool[0] ?? ""), "description") ?? null],
        thinking: deltasOf(events, 0, "thinking_delta", "thinking"),
        signatures: deltasOf(events, 0, "signature_delta", "signature"),
        heldTextBeforeStop: order.lastIndexOf("content_block_delta:1") < order.indexOf("content_block_stop:1"),
        toolBeforeStop: order.lastIndexOf("content_block_delta:2") < order.indexOf("content_block_stop:2"),
        ending: order.slice(-2),
        rewrittenUntouched: UNTOUCHED_EVENTS.filter((raw) => !output.replaceAll("\r\n", "\n").includes(raw)),
    };
};

const RESTORED_TURN = {
    // The restored text, including a dangling `⟦PER` that never became a token.
    text: `Napiszę do Jan Kowalski (jan.kowalski@example.pl) — zażółć 🎉 Zażółć Gęślą i ${ADDRESS} gotowe ⟦PER`,
    // ONE fragment, valid JSON with the address escaped and the model's big integer intact.
    tool: [
        `{"command": "echo Jan Kowalski > /tmp/a", "description": "Write ${JSON.stringify(ADDRESS).slice(1, -1)}", "count": 12345678901234567890}`,
    ],
    toolInput: ["echo Jan Kowalski > /tmp/a", `Write ${ADDRESS}`],
    // Thinking and its signature are byte for byte what the provider signed.
    thinking: ["The user is ⟦PERS", "ON_1⟧."],
    signatures: [SIGNATURE],
    heldTextBeforeStop: true,
    toolBeforeStop: true,
    ending: ["message_delta:", "message_stop:"],
    rewrittenUntouched: [],
};

describe("restoring an Anthropic Messages stream", () => {
    test("a Claude Code turn is restored however the bytes are cut", async () => {
        const output = await runEverySplit(() => restoreStream("anthropic", restore), claudeCodeStream());
        expect(turnOf(output)).toEqual(RESTORED_TURN);
        expect(RESTORED_TURN.text).toBe(restore(TEXT_DELTAS.join("")));
    });

    test("CRLF framing is read the same way", async () => {
        const output = await runEverySplit(() => restoreStream("anthropic", restore), claudeCodeStream("\r\n"));
        expect(turnOf(output)).toEqual(RESTORED_TURN);
        // Rewritten events use `\n`, which is equally valid SSE; untouched ones keep the provider's `\r\n`.
        expect(output).toContain('event: ping\r\ndata: {"type":"ping"}\r\n\r\n');
    });

    test("only text deltas that settled are sent, and a stream with nothing to restore is unchanged", async () => {
        const plain = sse([
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello there" } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ]);
        expect(await runText(restoreStream("anthropic", restore), plain)).toBe(plain);
        // A delta that is all held back is dropped, not sent empty; its text arrives with the next one.
        const held = sse([
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "⟦PERSON" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "_1⟧" } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ]);
        expect(deltasOf(payloads(await runText(restoreStream("anthropic", restore), held)), 0, "text_delta", "text")).toEqual(["Jan Kowalski"]);
    });

    test("tokens already in message_start and in a block's opening are restored", async () => {
        const start = sse([
            ["message_start", { type: "message_start", message: { id: "msg_01", content: [{ type: "text", text: "Hi ⟦PERSON_1⟧" }] } }],
            [
                "content_block_start",
                {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "⟦PERSON_1⟧" } },
                },
            ],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ]);
        const events = payloads(await runText(restoreStream("anthropic", restore), start));
        expect(at(events[0], "message", "content", 0, "text")).toBe("Hi Jan Kowalski");
        expect(at(events[1], "content_block", "input")).toEqual({ command: "Jan Kowalski" });
    });

    test("a stream cut off mid-block still delivers what it held", async () => {
        // The connection drops before content_block_stop: the held tail and the tool input still reach the client.
        const cut = sse([
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bye ⟦PERSON_1" } }],
            ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } }],
            [
                "content_block_delta",
                { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"a": "⟦PERSON_1⟧' } },
            ],
        ]);
        const events = payloads(await runText(restoreStream("anthropic", restore), cut));
        expect(deltasOf(events, 0, "text_delta", "text").join("")).toBe("Bye ⟦PERSON_1");
        expect(deltasOf(events, 1, "input_json_delta", "partial_json")).toEqual(['{"a": "Jan Kowalski']);
    });

    test("an error event and non-JSON data pass through", async () => {
        const errors =
            'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\nevent: weird\ndata: not json ⟦PERSON_1⟧\n\n';
        const output = await runText(restoreStream("anthropic", restore), errors);
        expect(output).toBe(errors);
        expect(parseWire(output)).toHaveLength(2);
    });
});
