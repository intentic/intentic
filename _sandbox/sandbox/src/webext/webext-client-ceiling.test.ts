import type { RpcMessage } from "../agent/tools/turn-mounts.js";
import { fitToClient } from "./webext-client-ceiling.js";
import { fittedToClient } from "./webext-peer.js";

// A browser call for a runtime whose MCP client gives up at 60 s (Cursor): wait_for is cut to fit and says so, and
// chatgpt_image is refused before it starts, rather than either being cut off mid-call with nothing said.

const CURSOR = { clientCeilingMs: 60_000 };

const call = (name: string, args: Record<string, unknown> = {}): RpcMessage => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("a runtime whose client waits long enough, or a wait that fits, passes as it was", () => {
    expect(fitToClient(call("wait_for", { quietFor: 20, seconds: 540 }), {})).toEqual({ kind: "as-is" });
    expect(fitToClient(call("wait_for", { quietFor: 20, seconds: 540 }), { clientCeilingMs: 660_000 })).toEqual({ kind: "as-is" });
    expect(fitToClient(call("wait_for", { text: "Done" }), CURSOR)).toEqual({ kind: "as-is" });
    expect(fitToClient(call("wait_for", { text: "Done", seconds: 50 }), CURSOR)).toEqual({ kind: "as-is" });
    expect(fitToClient(call("snapshot"), CURSOR)).toEqual({ kind: "as-is" });
    expect(fitToClient({ jsonrpc: "2.0", id: 2, method: "tools/list" }, CURSOR)).toEqual({ kind: "as-is" });
});

test("a long wait_for is cut to 50 s under a 60 s client, with a line telling the agent to call it again", () => {
    const fitted = fitToClient(call("wait_for", { textGone: "Thinking", quietFor: 20, seconds: 540 }), CURSOR);
    expect(fitted).toMatchObject({
        kind: "shortened",
        message: { params: { name: "wait_for", arguments: { textGone: "Thinking", quietFor: 20, seconds: 50 } } },
        note: `This runtime's MCP client stops waiting at 60 s, so this wait_for was cut to 50 s instead of the 540 s asked. If the page is not there yet, call wait_for again to keep waiting.`,
    });
    // A quiet stretch longer than the shortened wait would be refused by the browser, so it is shortened too, and said.
    const quiet = fitToClient(call("wait_for", { quietFor: 55, seconds: 120 }), CURSOR);
    expect(quiet).toMatchObject({ kind: "shortened", message: { params: { arguments: { quietFor: 49, seconds: 50 } } } });
    expect(quiet.kind === "shortened" ? quiet.note : "").toContain("cut to 50 s and quietFor to 49 s");
});

test("chatgpt_image is refused before it starts under a 60 s client, naming the way that works there", () => {
    const fitted = fitToClient(call("chatgpt_image", { prompt: "a lotus" }), CURSOR);
    expect(fitted.kind).toBe("refused");
    const text = JSON.stringify(fitted.kind === "refused" ? fitted.answer : {});
    expect(text).toContain("needs a runtime that can wait up to 9 minutes");
    expect(text).toContain("call wait_for again and again with seconds at most 50");
    expect(text).toContain("save_media");
    expect(text).toContain(`"isError":true`);
});

test("through the browser's endpoint: the shortened call is what the browser is asked, and the note follows its answer", async () => {
    const asked: RpcMessage[] = [];
    const endpoint = fittedToClient(async (_target, message) => {
        asked.push(message);
        return { jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: "the page" }], isError: false } };
    });
    const signal = new AbortController().signal;
    const answer = await endpoint({ id: "chrome" }, call("wait_for", { quietFor: 20, seconds: 540 }), { name: "chrome", conversationId: "c", signal, ...CURSOR });
    expect(asked[0]?.params).toMatchObject({ arguments: { seconds: 50 } });
    expect(answer?.result).toMatchObject({ content: [{ text: "the page" }, { text: expect.stringContaining("call wait_for again") }] });
    // A refused call never reaches the browser.
    await endpoint({ id: "chrome" }, call("chatgpt_image", { prompt: "a lotus" }), { name: "chrome", conversationId: "c", signal, ...CURSOR });
    expect(asked).toHaveLength(1);
});
