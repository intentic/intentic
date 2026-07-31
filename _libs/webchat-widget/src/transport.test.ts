import { expect, test, vi } from "vitest";
import type { WebchatMessage } from "@intentic/sandbox-contract";
import { parseSseBlock, sendMessage, splitSseBlocks, WebchatError } from "./transport.js";

const ENDPOINT = { base: "https://sandbox-abc.example", automationId: "support" };
const MESSAGE: WebchatMessage = { conversationId: "v-1", content: "hello" };

// A body that hands its bytes over in exactly the chunks given, so a test can put the split anywhere.
const bodyOf = (chunks: string[]): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
            }
            controller.close();
        },
    });
};

const collect = async (chunks: string[]): Promise<{ text: string; pending: string[] }> => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(bodyOf(chunks), { status: 200 })),
    );
    let text = ``;
    const pending: string[] = [];
    await sendMessage(ENDPOINT, MESSAGE, { delta: (part) => (text += part), pending: (notice) => pending.push(notice) });
    return { text, pending };
};

test(`a data line keeps everything past the single framing space`, () => {
    expect(parseSseBlock(`event: delta\ndata:   indented`)?.data).toBe(`  indented`);
});

test(`hono splits a multi-line payload into one data line each — rejoining restores it exactly`, () => {
    // What writeSSE({event: "delta", data: "a\n\nb"}) puts on the wire.
    expect(parseSseBlock(`event: delta\ndata: a\ndata: \ndata: b`)).toEqual({ event: `delta`, data: `a\n\nb` });
});

test(`a block with no data line (a keepalive comment) is not a frame`, () => {
    expect(parseSseBlock(`: keepalive`)).toBeUndefined();
});

test(`an event-less block defaults to "message", matching the SSE spec`, () => {
    expect(parseSseBlock(`data: bare`)?.event).toBe(`message`);
});

test(`splitting keeps the unterminated tail back for the next chunk`, () => {
    const { blocks, rest } = splitSseBlocks(`event: delta\ndata: one\n\nevent: delta\ndata: tw`);
    expect(blocks).toEqual([`event: delta\ndata: one`]);
    expect(rest).toBe(`event: delta\ndata: tw`);
});

test(`\\r\\n framing is accepted — some proxies rewrite line endings`, () => {
    expect(splitSseBlocks(`event: delta\r\ndata: one\r\n\r\n`).blocks).toEqual([`event: delta\ndata: one`]);
});

test(`deltas arriving split mid-frame still reassemble in order`, async () => {
    const { text } = await collect([`event: delta\ndata: Hel`, `lo the`, `re\n\nevent: delta\ndata:  world\n\nevent: done\ndata: \n\n`]);
    expect(text).toBe(`Hello there world`);
});

test(`a pending frame reaches the sink and no text is invented for it`, async () => {
    const { text, pending } = await collect([`event: pending\ndata: A human will review it.\n\nevent: done\ndata: \n\n`]);
    expect(pending).toEqual([`A human will review it.`]);
    expect(text).toBe(``);
});

test(`a stream that ends without a done frame still delivers what arrived`, async () => {
    const { text } = await collect([`event: delta\ndata: partial\n\n`]);
    expect(text).toBe(`partial`);
});

test(`a refusal surfaces the daemon's own sentence and its status, not a generic failure`, async () => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(JSON.stringify({ error: `origin not allowed` }), { status: 403 })),
    );
    await expect(sendMessage(ENDPOINT, MESSAGE, { delta: () => {}, pending: () => {} })).rejects.toThrow(
        expect.objectContaining({ message: `origin not allowed`, status: 403 }) as Error,
    );
});

test(`a refusal with no JSON body still names its status`, async () => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(`<html>502</html>`, { status: 502 })),
    );
    const error = await sendMessage(ENDPOINT, MESSAGE, { delta: () => {}, pending: () => {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WebchatError);
    expect((error as WebchatError).message).toContain(`502`);
});

test(`the message posts to the automation's own path`, async () => {
    const urls: string[] = [];
    vi.stubGlobal(
        `fetch`,
        vi.fn(async (url: string) => {
            urls.push(url);
            return new Response(bodyOf([`event: done\ndata: \n\n`]), { status: 200 });
        }),
    );
    await sendMessage(ENDPOINT, MESSAGE, { delta: () => {}, pending: () => {} });
    expect(urls).toEqual([`https://sandbox-abc.example/webchat/support/message`]);
});
