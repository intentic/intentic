import { restoreResponse, restoreStream } from "../index.js";
import { isText, type Json, type JsonObject } from "../walk.js";
import { at, restore } from "./fake-shield.testing.js";
import { payloads, runEverySplit, runText, sse } from "./stream.testing.js";

// What Codex receives must name real people again, in the message it shows and in the calls it runs; reasoning is the
// provider's encrypted state and must arrive exactly as written.

const ADDRESS = 'ul. "Długa" 5\n00-001 Warszawa';
const REASONING = {
    id: "rs_1",
    type: "reasoning",
    encrypted_content: "gAAAAABo⟦PERSON_1⟧",
    summary: [{ type: "summary_text", text: "**Mail ⟦PERSON_1⟧**" }],
};
// Ends on a `[` that could have opened a token, so the last of it is held until `.done` and sent as a synthetic delta.
const TEXT = "Napiszę do ⟦PERSON_1⟧ (⟦EMAIL_1⟧) — zażółć 🎉 [[PERSON_2]] i ⟦ADDRESS_1⟧, zobacz [";
const RESTORED_TEXT = `Napiszę do Jan Kowalski (jan.kowalski@example.pl) — zażółć 🎉 Zażółć Gęślą i ${ADDRESS}, zobacz [`;
const ARGS = '{"command":["bash","-lc","echo ⟦PERSON_1⟧ > ⟦ADDRESS_1⟧"],"timeout_ms":12345678901234567890}';
const RESTORED_ARGS = `{"command":["bash","-lc","echo Jan Kowalski > ${JSON.stringify(ADDRESS).slice(1, -1)}"],"timeout_ms":12345678901234567890}`;
const PATCH = "*** Begin Patch\n*** Add File: ⟦PERSON_1⟧.txt\n+⟦ADDRESS_1⟧\n*** End Patch";

const message = (text: string): JsonObject => ({
    id: "msg_1",
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", annotations: [], logprobs: [], text }],
});
const call = (args: string): JsonObject => ({
    id: "fc_1",
    type: "function_call",
    status: "completed",
    arguments: args,
    call_id: "call_1",
    name: "shell",
});
const custom = (input: string): JsonObject => ({
    id: "ctc_1",
    type: "custom_tool_call",
    status: "completed",
    call_id: "call_2",
    name: "apply_patch",
    input,
});

describe("restoring a Responses body", () => {
    test("message text, function arguments, custom input and shell commands are restored; reasoning is not", () => {
        const body = {
            id: "resp_1",
            object: "response",
            status: "completed",
            output: [
                REASONING,
                message(TEXT),
                call(ARGS),
                custom(PATCH),
                {
                    type: "local_shell_call",
                    id: "lsh_1",
                    call_id: "call_3",
                    status: "completed",
                    action: { type: "exec", command: ["echo", "⟦PERSON_1⟧"], env: {} },
                },
                { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "⟦PERSON_1⟧" } },
            ],
            output_text: TEXT,
            usage: { input_tokens: 10, output_tokens: 20 },
        };
        const restored = restoreResponse("responses", body, restore);
        expect(at(restored, "output", 0)).toBe(REASONING);
        expect(at(restored, "output", 1, "content", 0, "text")).toBe(RESTORED_TEXT);
        expect(at(restored, "output", 2, "arguments")).toBe(RESTORED_ARGS);
        expect(at(restored, "output", 3, "input")).toBe(`*** Begin Patch\n*** Add File: Jan Kowalski.txt\n+${ADDRESS}\n*** End Patch`);
        expect(at(restored, "output", 4, "action", "command")).toEqual(["echo", "Jan Kowalski"]);
        expect(at(restored, "output", 5)).toBe(body.output[5]);
        expect(at(restored, "output_text")).toBe(RESTORED_TEXT);
        expect(at(restored, "usage")).toBe(body.usage);
    });
});

// A Codex turn as the API streams it: reasoning with its summary, a message whose tokens and multibyte letters land
// across deltas, a function call and a freeform patch whose text is cut mid-token, then the completed snapshot.
const TEXT_DELTAS = ["Napiszę do ⟦PERS", "ON_1⟧ (", "⟦EMAIL_1", "⟧) — zażółć 🎉 ", "[[PERSON_2]", "] i ⟦ADDRESS_1⟧, zobacz ["];
const ARG_DELTAS = ['{"command":["bash","-lc","echo ⟦PER', "SON_1⟧ > ⟦ADDRESS_1", '⟧"],"timeout_ms":12345678901234567890}'];
const PATCH_DELTAS = ["*** Begin Patch\n*** Add File: ⟦PERSON", "_1⟧.txt\n+⟦ADDRESS_1⟧\n*** End Patch"];
const UNKNOWN = { type: "response.future_event", sequence_number: 99, note: "⟦PERSON_1⟧" };

const codexStream = (newline = "\n"): string => {
    let sequence = 0;
    const event = (type: string, fields: JsonObject): readonly [string, Json] => [type, { type, sequence_number: sequence++, ...fields }];
    const response = (status: string, output: readonly Json[]): JsonObject => ({
        id: "resp_1",
        object: "response",
        created_at: 1_759_300_000,
        status,
        model: "gpt-5-codex",
        output,
        usage: null,
    });
    return sse(
        [
            event("response.created", { response: response("in_progress", []) }),
            event("response.in_progress", { response: response("in_progress", []) }),
            event("response.output_item.added", {
                output_index: 0,
                item: { id: "rs_1", type: "reasoning", encrypted_content: "gAAAAABo", summary: [] },
            }),
            event("response.reasoning_summary_part.added", {
                item_id: "rs_1",
                output_index: 0,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
            }),
            event("response.reasoning_summary_text.delta", {
                item_id: "rs_1",
                output_index: 0,
                summary_index: 0,
                delta: "**Mail ⟦PERSON_1⟧**",
                obfuscation: "x9",
            }),
            event("response.reasoning_summary_text.done", { item_id: "rs_1", output_index: 0, summary_index: 0, text: "**Mail ⟦PERSON_1⟧**" }),
            event("response.output_item.done", { output_index: 0, item: REASONING }),
            event("response.output_item.added", { output_index: 1, item: { ...message(""), status: "in_progress", content: [] } }),
            event("response.content_part.added", {
                item_id: "msg_1",
                output_index: 1,
                content_index: 0,
                part: { type: "output_text", annotations: [], logprobs: [], text: "" },
            }),
            ...TEXT_DELTAS.map((delta) =>
                event("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta, logprobs: [], obfuscation: "abc" }),
            ),
            ["response.future_event", UNKNOWN] as const,
            event("response.output_text.done", { item_id: "msg_1", output_index: 1, content_index: 0, text: TEXT, logprobs: [] }),
            event("response.content_part.done", {
                item_id: "msg_1",
                output_index: 1,
                content_index: 0,
                part: { type: "output_text", annotations: [], logprobs: [], text: TEXT },
            }),
            event("response.output_item.done", { output_index: 1, item: message(TEXT) }),
            event("response.output_item.added", { output_index: 2, item: { ...call(""), status: "in_progress" } }),
            ...ARG_DELTAS.map((delta) =>
                event("response.function_call_arguments.delta", { item_id: "fc_1", output_index: 2, delta, obfuscation: "q" }),
            ),
            event("response.function_call_arguments.done", { item_id: "fc_1", output_index: 2, arguments: ARGS }),
            event("response.output_item.done", { output_index: 2, item: call(ARGS) }),
            event("response.output_item.added", { output_index: 3, item: { ...custom(""), status: "in_progress" } }),
            ...PATCH_DELTAS.map((delta) => event("response.custom_tool_call_input.delta", { item_id: "ctc_1", output_index: 3, delta })),
            event("response.custom_tool_call_input.done", { item_id: "ctc_1", output_index: 3, input: PATCH }),
            event("response.output_item.done", { output_index: 3, item: custom(PATCH) }),
            event("response.completed", {
                response: {
                    ...response("completed", [REASONING, message(TEXT), call(ARGS), custom(PATCH)]),
                    usage: { input_tokens: 9, output_tokens: 9, total_tokens: 18 },
                },
            }),
        ],
        newline,
    );
};

const ofType = (events: readonly JsonObject[], type: string): readonly JsonObject[] => events.filter((event) => event["type"] === type);
const texts = (events: readonly JsonObject[], field: string): readonly string[] =>
    events.flatMap((event) => {
        const value = event[field];
        return isText(value) ? [value] : [];
    });

const RESTORED_PATCH = `*** Begin Patch\n*** Add File: Jan Kowalski.txt\n+${ADDRESS}\n*** End Patch`;

// What Codex makes of the stream: the text it shows, the call text it parses, the items it records in its history,
// and whether everything arrived in an order it accepts.
const turnOf = (output: string): JsonObject => {
    const events = payloads(output);
    const order = events.map((event) => String(event["type"]));
    return {
        text: texts(ofType(events, "response.output_text.delta"), "delta").join(""),
        textDone: texts(ofType(events, "response.output_text.done"), "text"),
        partDone: at(ofType(events, "response.content_part.done")[0], "part", "text") ?? null,
        // Arguments and patch input arrive as ONE delta each, equal to what `.done` says.
        args: texts(ofType(events, "response.function_call_arguments.delta"), "delta"),
        argsDone: texts(ofType(events, "response.function_call_arguments.done"), "arguments"),
        patch: texts(ofType(events, "response.custom_tool_call_input.delta"), "delta"),
        patchDone: texts(ofType(events, "response.custom_tool_call_input.done"), "input"),
        items: ofType(events, "response.output_item.done").map((event) => event["item"] ?? null),
        completed: at(ofType(events, "response.completed")[0], "response", "output") ?? null,
        summary: texts(ofType(events, "response.reasoning_summary_text.delta"), "delta"),
        textBeforeDone: order.lastIndexOf("response.output_text.delta") < order.indexOf("response.output_text.done"),
        argsBeforeDone: order.lastIndexOf("response.function_call_arguments.delta") < order.indexOf("response.function_call_arguments.done"),
        last: order.at(-1) ?? null,
        unknownForwarded: output.replaceAll("\r\n", "\n").includes(`event: response.future_event\ndata: ${JSON.stringify(UNKNOWN)}\n\n`),
    };
};

const RESTORED_TURN = {
    text: RESTORED_TEXT,
    textDone: [RESTORED_TEXT],
    partDone: RESTORED_TEXT,
    args: [RESTORED_ARGS],
    argsDone: [RESTORED_ARGS],
    patch: [RESTORED_PATCH],
    patchDone: [RESTORED_PATCH],
    // The items Codex records in its history are the restored ones; reasoning is untouched.
    items: [REASONING, message(RESTORED_TEXT), call(RESTORED_ARGS), custom(RESTORED_PATCH)],
    completed: [REASONING, message(RESTORED_TEXT), call(RESTORED_ARGS), custom(RESTORED_PATCH)],
    summary: ["**Mail ⟦PERSON_1⟧**"],
    textBeforeDone: true,
    argsBeforeDone: true,
    last: "response.completed",
    unknownForwarded: true,
};

describe("restoring a Responses stream", () => {
    test("a Codex turn is restored however the bytes are cut", async () => {
        expect(turnOf(await runEverySplit(() => restoreStream("responses", restore), codexStream()))).toEqual(RESTORED_TURN);
        expect(JSON.parse(RESTORED_ARGS)).toMatchObject({ command: ["bash", "-lc", `echo Jan Kowalski > ${ADDRESS}`] });
    });

    test("CRLF framing is read the same way", async () => {
        expect(turnOf(await runEverySplit(() => restoreStream("responses", restore), codexStream("\r\n")))).toEqual(RESTORED_TURN);
    });

    test("the synthetic deltas carry the ids and sequence number of the event they precede", async () => {
        const events = payloads(await runText(restoreStream("responses", restore), codexStream()));
        const lastText = ofType(events, "response.output_text.delta").at(-1);
        const textDone = ofType(events, "response.output_text.done")[0];
        expect(lastText).toEqual({
            type: "response.output_text.delta",
            item_id: "msg_1",
            output_index: 1,
            content_index: 0,
            delta: "[",
            sequence_number: textDone?.["sequence_number"] ?? -1,
        });
        const args = ofType(events, "response.function_call_arguments.delta")[0];
        const argsDone = ofType(events, "response.function_call_arguments.done")[0];
        expect(args).toMatchObject({ item_id: "fc_1", output_index: 2, sequence_number: argsDone?.["sequence_number"] ?? -1 });
    });

    test("a response that ends without its .done events still delivers what was held", async () => {
        // A failed or incomplete response skips the per-part `.done` events; the held text must not be lost with them.
        const cut = sse([
            [
                "response.output_text.delta",
                { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Bye ⟦PERSON_1" },
            ],
            [
                "response.function_call_arguments.delta",
                { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"a":"⟦PERSON_1⟧"}' },
            ],
            ["response.incomplete", { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", output: [] } }],
        ]);
        const events = payloads(await runText(restoreStream("responses", restore), cut));
        expect(events.map((event) => event["type"])).toEqual([
            "response.output_text.delta",
            "response.output_text.delta",
            "response.function_call_arguments.delta",
            "response.incomplete",
        ]);
        expect(texts(ofType(events, "response.output_text.delta"), "delta")).toEqual(["Bye ", "⟦PERSON_1"]);
        expect(at(events[2], "delta")).toBe('{"a":"Jan Kowalski"}');
    });

    test("a call whose text arrives only in .done is restored there, as JSON or as plain text by its kind", async () => {
        // Some servers skip the deltas. A freeform patch is not JSON: its quotes and newlines must not be escaped.
        const doneOnly = sse([
            [
                "response.function_call_arguments.done",
                { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"to":"⟦ADDRESS_1⟧"}' },
            ],
            [
                "response.custom_tool_call_input.done",
                { type: "response.custom_tool_call_input.done", item_id: "ctc_1", output_index: 1, input: "+⟦ADDRESS_1⟧" },
            ],
        ]);
        const events = payloads(await runText(restoreStream("responses", restore), doneOnly));
        expect(events).toEqual([
            {
                type: "response.function_call_arguments.done",
                item_id: "fc_1",
                output_index: 0,
                arguments: `{"to":"${JSON.stringify(ADDRESS).slice(1, -1)}"}`,
            },
            { type: "response.custom_tool_call_input.done", item_id: "ctc_1", output_index: 1, input: `+${ADDRESS}` },
        ]);
    });

    test("a stream with nothing to restore comes out unchanged", async () => {
        const plain = sse([
            [
                "response.output_text.delta",
                { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
            ],
            ["response.output_text.done", { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello" }],
            ["error", { type: "error", code: "server_error", message: "boom", param: null }],
        ]);
        expect(await runText(restoreStream("responses", restore), plain)).toBe(plain);
    });
});
