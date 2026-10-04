import { isList, isRecord, isText, type Json, type JsonObject } from "./protocols/walk.js";
import { CLEARED_PLACEHOLDER, clearToolResults, type ClearingLimits } from "./tool-result-clearing.js";

// Old tool results replaced a chunk at a time: the kept window and short results stay whole, the boundary is a pure
// function of the history, and it moves only when another whole chunk has piled up behind the window, so the prompt the
// provider caches is the same from one call to the next until then.

// Small enough to read: 4 characters a token, so a 400-character result is 100 tokens.
const LIMITS: ClearingLimits = { triggerTokens: 10, keepResults: 2, chunkTokens: 200, minResultChars: 40 };

const result = (id: string, chars: number, extra: JsonObject = {}): JsonObject => ({
    type: "tool_result",
    tool_use_id: id,
    content: "x".repeat(chars),
    ...extra,
});
const call = (id: string): JsonObject => ({ role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] });

// A history of `sizes.length` tool calls, one result each, in the order given.
const historyOf = (sizes: readonly number[], extra: (index: number) => JsonObject = () => ({})): JsonObject => ({
    model: "claude-opus-5-5",
    messages: [
        { role: "user", content: "go" },
        ...sizes.flatMap((chars, index) => [call(`t${index}`), { role: "user", content: [result(`t${index}`, chars, extra(index))] }]),
    ],
});

const messagesOf = (body: Json): readonly Json[] => {
    const messages = isRecord(body) ? body["messages"] : undefined;
    return isList(messages) ? messages : [];
};

// Every tool result block, oldest first.
const resultBlocks = (body: Json): JsonObject[] =>
    messagesOf(body).flatMap((message) => {
        const content = isRecord(message) ? message["content"] : undefined;
        return isList(content) ? content.filter((part): part is JsonObject => isRecord(part) && part["type"] === "tool_result") : [];
    });

// What each result says now, oldest first; a block of parts reads as its parts' count.
const said = (body: Json): string[] =>
    resultBlocks(body).map((block) => {
        const content = block["content"];
        return isText(content) ? content : `${isList(content) ? content.length : 0} parts`;
    });
const clearedCount = (body: Json): number => said(body).filter((text) => text === CLEARED_PLACEHOLDER).length;

test("a prompt under the trigger goes as it came", () => {
    const body = historyOf([400, 400, 400]);
    const outcome = clearToolResults(body, { ...LIMITS, triggerTokens: 1_000_000 });
    expect(outcome.body).toBe(body);
    expect(outcome.cleared).toBe(0);
});

test("the oldest results go, whole chunks of them, and the kept window stays whole", () => {
    // Six results of 100 tokens: four behind the window (400 tokens, two whole chunks), so all four go.
    const outcome = clearToolResults(historyOf([400, 400, 400, 400, 400, 400]), LIMITS);
    expect(outcome.cleared).toBe(4);
    expect(outcome.clearedTokens).toBe(400);
    expect(said(outcome.body)).toEqual([...Array.from({ length: 4 }, () => CLEARED_PLACEHOLDER), "x".repeat(400), "x".repeat(400)]);
});

test("what lies behind the window short of a whole chunk stays until the next chunk fills", () => {
    // Behind the window: 100 + 100 + 100 tokens. One chunk is 200, so the oldest two go and the third waits.
    const outcome = clearToolResults(historyOf([400, 400, 400, 400, 400]), LIMITS);
    expect(outcome.cleared).toBe(2);
    expect(said(outcome.body)).toEqual([CLEARED_PLACEHOLDER, CLEARED_PLACEHOLDER, "x".repeat(400), "x".repeat(400), "x".repeat(400)]);
});

test("the boundary holds as the history grows, so the cached prompt does not move, until another chunk piles up", () => {
    // Behind the window: 300 tokens, one whole chunk, so two results go.
    const sizes = [400, 400, 400, 40, 400];
    const before = messagesOf(clearToolResults(historyOf(sizes), LIMITS).body);
    // One more call pushes only the short result behind the window: still 300 tokens there, and every message the
    // last call sent is sent again exactly as it was.
    const grown = clearToolResults(historyOf([...sizes, 400]), LIMITS).body;
    expect(messagesOf(grown).slice(0, before.length)).toEqual([...before]);
    expect(clearedCount(grown)).toBe(2);
    // One more large one behind the window makes it 400 tokens, two whole chunks, and the boundary moves.
    expect(clearedCount(clearToolResults(historyOf([...sizes, 400, 400]), LIMITS).body)).toBe(4);
});

test("a short result is never replaced, and does not count towards a chunk", () => {
    const outcome = clearToolResults(historyOf([39, 400, 400, 400, 400]), LIMITS);
    expect(outcome.cleared).toBe(2);
    expect(said(outcome.body)).toEqual(["x".repeat(39), CLEARED_PLACEHOLDER, CLEARED_PLACEHOLDER, "x".repeat(400), "x".repeat(400)]);
});

test("a replaced block keeps its id, its error flag and its cache mark", () => {
    const outcome = clearToolResults(
        historyOf([400, 400, 400, 400], (index) => (index === 0 ? { is_error: true, cache_control: { type: "ephemeral" } } : {})),
        LIMITS,
    );
    expect(resultBlocks(outcome.body)[0]).toEqual({
        type: "tool_result",
        tool_use_id: "t0",
        content: CLEARED_PLACEHOLDER,
        is_error: true,
        cache_control: { type: "ephemeral" },
    });
});

test("an image inside a result is weighed as a screenshot, and the whole result is replaced", () => {
    const screenshot: JsonObject = {
        type: "tool_result",
        tool_use_id: "s",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }],
    };
    const body: JsonObject = {
        messages: [
            { role: "user", content: "go" },
            call("s"),
            { role: "user", content: [screenshot] },
            ...[1, 2, 3].flatMap((index) => [call(`t${index}`), { role: "user", content: [result(`t${index}`, 400)] }]),
        ],
    };
    // Behind the window: the image, reckoned at 1,500 tokens, and one 100-token result; eight whole chunks, both go.
    const outcome = clearToolResults(body, LIMITS);
    expect(outcome.cleared).toBe(2);
    expect(outcome.clearedTokens).toBe(1_600);
    expect(resultBlocks(outcome.body)[0]).toEqual({ type: "tool_result", tool_use_id: "s", content: CLEARED_PLACEHOLDER });
});

test("a request that is not a Messages request goes as it came", () => {
    const bodies: Json[] = [null, "text", { input: "x".repeat(10_000) }, { messages: "nope" }];
    for (const body of bodies) {
        expect(clearToolResults(body, LIMITS).body).toBe(body);
    }
});
