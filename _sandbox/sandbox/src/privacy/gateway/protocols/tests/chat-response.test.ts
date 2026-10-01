import { restoreResponse, restoreStream } from "../index.js";
import { isCount, isList, isRecord, isText, type Json, type JsonObject } from "../walk.js";
import { at, restore } from "./fake-shield.testing.js";
import { parseWire, payloads, runEverySplit, runText, sse } from "./stream.testing.js";

// What OpenCode receives must name real people again, in its text and in the tool calls it runs. The Vercel AI SDK it
// uses ends a tool call the moment the arguments so far parse as JSON, so that moment must come only once they are
// whole and restored.

const ADDRESS = 'ul. "Długa" 5\n00-001 Warszawa';
const ESCAPED_ADDRESS = JSON.stringify(ADDRESS).slice(1, -1);

describe("restoring a Chat Completions body", () => {
    test("content and tool call arguments are restored, reasoning is not", () => {
        const body = {
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1_759_300_000,
            model: "deepseek-chat",
            choices: [
                {
                    index: 0,
                    message: {
                        role: "assistant",
                        content: "Mail to ⟦PERSON_1⟧ at [[EMAIL_1]]",
                        reasoning_content: "Thinking about ⟦PERSON_1⟧",
                        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"echo ⟦ADDRESS_1⟧"}' } }],
                    },
                    finish_reason: "tool_calls",
                },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 9, total_tokens: 18 },
        };
        const restored = restoreResponse("chat", body, restore);
        expect(at(restored, "choices", 0, "message")).toEqual({
            role: "assistant",
            content: "Mail to Jan Kowalski at jan.kowalski@example.pl",
            reasoning_content: "Thinking about ⟦PERSON_1⟧",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: `{"command":"echo ${ESCAPED_ADDRESS}"}` } }],
        });
        expect(at(restored, "usage")).toBe(body.usage);
    });
});

// An OpenAI-compatible stream as OpenRouter relays DeepSeek's: a role chunk, a processing comment, reasoning, content
// whose tokens and multibyte letters land across chunks, one tool call streamed in fragments cut mid-token and one
// sent whole, the finish, a usage chunk and [DONE].
const TEXT_DELTAS = ["Piszę do ⟦PERS", "ON_1⟧ — zażółć 🎉 [[PERSON_2]", "] [", "[EMAIL_1]]"];
const RESTORED_TEXT = "Piszę do Jan Kowalski — zażółć 🎉 Zażółć Gęślą jan.kowalski@example.pl";
const ARG_FRAGMENTS = ['{"command":', ' "echo ⟦PER', 'SON_1⟧ > ⟦ADDRESS_1⟧"', ', "timeout": 12345678901234567890}'];
const RESTORED_ARGS = `{"command": "echo Jan Kowalski > ${ESCAPED_ADDRESS}", "timeout": 12345678901234567890}`;

const chunk = (choices: readonly Json[], extra: JsonObject = {}): JsonObject => ({
    id: "gen-1759300000-abc",
    provider: "DeepSeek",
    model: "deepseek/deepseek-chat-v3.1",
    object: "chat.completion.chunk",
    created: 1_759_300_000,
    choices,
    ...extra,
});
const delta = (fields: JsonObject, finish: string | null = null): JsonObject => ({
    index: 0,
    delta: fields,
    finish_reason: finish,
    native_finish_reason: finish,
    logprobs: null,
});

const openRouterStream = (newline = "\n"): string =>
    [
        sse([[undefined, chunk([delta({ role: "assistant", content: "" })])]], newline),
        `: OPENROUTER PROCESSING${newline}${newline}`,
        sse(
            [
                [
                    undefined,
                    chunk([
                        delta({
                            role: "assistant",
                            content: "",
                            reasoning: "About ⟦PERSON_1⟧",
                            reasoning_details: [{ type: "reasoning.text", text: "About ⟦PERSON_1⟧" }],
                        }),
                    ]),
                ],
                ...TEXT_DELTAS.map((content) => [undefined, chunk([delta({ role: "assistant", content })])] as const),
                [
                    undefined,
                    chunk([
                        delta({
                            role: "assistant",
                            content: null,
                            tool_calls: [{ index: 0, id: "call_00_x", type: "function", function: { name: "bash", arguments: "" } }],
                        }),
                    ]),
                ],
                ...ARG_FRAGMENTS.map(
                    (args) =>
                        [
                            undefined,
                            chunk([delta({ role: "assistant", content: null, tool_calls: [{ index: 0, function: { arguments: args } }] })]),
                        ] as const,
                ),
                [
                    undefined,
                    chunk([
                        delta({
                            role: "assistant",
                            content: null,
                            tool_calls: [
                                { index: 1, id: "call_01_y", type: "function", function: { name: "read", arguments: '{"path":"⟦PERSON_1⟧.txt"}' } },
                            ],
                        }),
                    ]),
                ],
                [undefined, chunk([delta({ role: "assistant", content: "" }, "tool_calls")])],
                [undefined, chunk([], { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })],
                [undefined, "[DONE]"],
            ],
            newline,
        ),
    ].join("");

const isParsable = (text: string): boolean => {
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
};

// The Vercel AI SDK's OpenAI-compatible tool call assembly, reduced to what decides a call's input: a call opens on a
// delta with an id and a name, accumulates argument fragments, and is final the first time they parse.
const aiSdkToolInputs = (events: readonly JsonObject[]): ReadonlyMap<number, string> => {
    const open = new Map<number, string>();
    const final = new Map<number, string>();
    for (const call of events.flatMap((event) => {
        const calls = at(event, "choices", 0, "delta", "tool_calls");
        return isList(calls) ? calls : [];
    })) {
        const index = at(call, "index");
        const args = at(call, "function", "arguments");
        if (!isCount(index) || final.has(index)) {
            continue;
        }
        if (!open.has(index)) {
            expect(isText(at(call, "id")) && isText(at(call, "function", "name"))).toBe(true);
        }
        const sofar = (open.get(index) ?? "") + (isText(args) ? args : "");
        open.set(index, sofar);
        if (isParsable(sofar)) {
            final.set(index, sofar);
        }
    }
    return final;
};

const contentOf = (events: readonly JsonObject[]): string =>
    events
        .map((event) => at(event, "choices", 0, "delta", "content"))
        .filter((content) => isText(content))
        .join("");

// What OpenCode makes of the stream: the text it shows, the tool inputs the AI SDK settles on, every argument fragment
// it was handed, and whether everything arrived in an order it accepts.
const turnOf = (output: string): JsonObject => {
    const events = payloads(output);
    const fragments = events.flatMap((event) => {
        const calls = at(event, "choices", 0, "delta", "tool_calls");
        return (isList(calls) ? calls : []).map((call) => at(call, "function", "arguments") ?? null).filter((args) => isText(args) && args !== "");
    });
    const finishAt = events.findIndex((event) => at(event, "choices", 0, "finish_reason") === "tool_calls");
    const lastDelta = events.findLastIndex((event) => {
        const fields = at(event, "choices", 0, "delta");
        return isRecord(fields) && ((isText(fields["content"]) && fields["content"] !== "") || isList(fields["tool_calls"]));
    });
    const synthetic = events.find((event) => at(event, "choices", 0, "delta", "tool_calls", 0, "function", "arguments") === RESTORED_ARGS);
    return {
        text: contentOf(events),
        toolInputs: [...aiSdkToolInputs(events)],
        fragments,
        reasoning: at(events[1], "choices", 0, "delta", "reasoning") ?? null,
        heldBeforeFinish: lastDelta < finishAt,
        usageLast: at(events.at(-1), "usage") ?? null,
        done: parseWire(output).at(-1)?.data ?? null,
        commentForwarded: output.includes(": OPENROUTER PROCESSING"),
        envelope: [at(synthetic, "id") ?? null, at(synthetic, "object") ?? null, at(synthetic, "created") ?? null, at(synthetic, "model") ?? null],
    };
};

const RESTORED_TURN = {
    text: RESTORED_TEXT,
    toolInputs: [
        [0, RESTORED_ARGS],
        [1, '{"path":"Jan Kowalski.txt"}'],
    ],
    // Each call's arguments arrive as one fragment: the client never holds a parsable prefix of them.
    fragments: [RESTORED_ARGS, '{"path":"Jan Kowalski.txt"}'],
    // The provider's reasoning is forwarded as it came.
    reasoning: "About ⟦PERSON_1⟧",
    // Everything held goes out before the finish; the usage chunk and [DONE] after it.
    heldBeforeFinish: true,
    usageLast: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    done: "[DONE]",
    commentForwarded: true,
    // The synthetic chunk carries the stream's own envelope.
    envelope: ["gen-1759300000-abc", "chat.completion.chunk", 1_759_300_000, "deepseek/deepseek-chat-v3.1"],
};

describe("restoring a Chat Completions stream", () => {
    test("an OpenRouter turn is restored however the bytes are cut", async () => {
        expect(turnOf(await runEverySplit(() => restoreStream("chat", restore), openRouterStream()))).toEqual(RESTORED_TURN);
    });

    test("CRLF framing is read the same way", async () => {
        expect(turnOf(await runEverySplit(() => restoreStream("chat", restore), openRouterStream("\r\n")))).toEqual(RESTORED_TURN);
    });

    test("a chunk that carries content and the finish together delivers the content first", async () => {
        // Gemini's OpenAI-compatible endpoint puts the last text and finish_reason in one chunk.
        const gemini = sse([
            [undefined, chunk([delta({ role: "assistant", content: "Bye ⟦PERS" })])],
            [undefined, chunk([delta({ content: "ON_1⟧ [" }, "stop")])],
            [undefined, "[DONE]"],
        ]);
        const events = payloads(await runText(restoreStream("chat", restore), gemini));
        expect(contentOf(events)).toBe("Bye Jan Kowalski [");
        expect(events.map((event) => at(event, "choices", 0, "finish_reason"))).toEqual([null, null, null, "stop"]);
        expect(at(events.at(-1), "choices", 0, "delta")).toEqual({});
    });

    test("a stream that ends without [DONE] still delivers what was held", async () => {
        const cut = sse([
            [undefined, chunk([delta({ content: "Hi ⟦PERSON_1" })])],
            [
                undefined,
                chunk([
                    delta({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "bash", arguments: '{"a":"⟦PERSON_1⟧"}' } }] }),
                ]),
            ],
        ]);
        const events = payloads(await runText(restoreStream("chat", restore), cut));
        expect(contentOf(events)).toBe("Hi ⟦PERSON_1");
        expect(aiSdkToolInputs(events)).toEqual(new Map([[0, '{"a":"Jan Kowalski"}']]));
    });

    test("a plain stream comes out unchanged, and chunks only held back are dropped", async () => {
        const plain = sse([
            [undefined, chunk([delta({ role: "assistant", content: "Hello" })])],
            [undefined, chunk([delta({}, "stop")])],
            [undefined, { error: { message: "rate limited", code: 429 } }],
            [undefined, "[DONE]"],
        ]);
        expect(await runText(restoreStream("chat", restore), plain)).toBe(plain);
        const held = sse([
            [undefined, chunk([delta({ content: "⟦PERSON" })])],
            [undefined, chunk([delta({ content: "_1⟧" })])],
            [undefined, "[DONE]"],
        ]);
        const events = payloads(await runText(restoreStream("chat", restore), held));
        expect(events.map((event) => at(event, "choices", 0, "delta", "content"))).toEqual(["Jan Kowalski"]);
    });
});
