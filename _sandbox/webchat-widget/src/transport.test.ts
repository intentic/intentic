import { expect, test, vi } from "vitest";
import type { WebchatMessage } from "@intentic/sandbox-contract";
import { EmbedError } from "@intentic/sandbox-contract/embed";
import { fetchPending, parseSseBlock, sendMessage, splitSseBlocks } from "./transport.js";

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

const collect = async (chunks: string[]): Promise<{ text: string; pending: string[]; failed: string[] }> => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(bodyOf(chunks), { status: 200 })),
    );
    let text = ``;
    const pending: string[] = [];
    const failed: string[] = [];
    await sendMessage(ENDPOINT, MESSAGE, {
        delta: (part) => (text += part),
        pending: (notice) => pending.push(notice),
        failed: (notice) => failed.push(notice),
    });
    return { text, pending, failed };
};

test(`a data line keeps everything past the single framing space`, () => {
    expect(parseSseBlock(`event: delta\ndata:   indented`)?.data).toBe(`  indented`);
});

test(`hono splits a multi-line payload into one data line each: rejoining restores it exactly`, () => {
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

test(`\\r\\n framing is accepted: some proxies rewrite line endings`, () => {
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

test(`an error frame reaches the sink, the turn answered with nothing, which is not an empty answer`, async () => {
    const { text, failed } = await collect([`event: error\ndata: Sorry, I couldn't answer that just now.\n\nevent: done\ndata: \n\n`]);
    expect(failed).toEqual([`Sorry, I couldn't answer that just now.`]);
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
    await expect(sendMessage(ENDPOINT, MESSAGE, { delta: () => {}, pending: () => {}, failed: () => {} })).rejects.toThrow(
        expect.objectContaining({ message: `origin not allowed`, status: 403 }) as Error,
    );
});

test(`a refusal with no JSON body still names its status`, async () => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(`<html>502</html>`, { status: 502 })),
    );
    const error = await sendMessage(ENDPOINT, MESSAGE, { delta: () => {}, pending: () => {}, failed: () => {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbedError);
    expect((error as EmbedError).message).toContain(`502`);
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
    await sendMessage(ENDPOINT, MESSAGE, { delta: () => {}, pending: () => {}, failed: () => {} });
    expect(urls).toEqual([`https://sandbox-abc.example/webchat/support/message`]);
});

test(`the poll names the visitor's thread and its cursor, so one browser never collects another's replies`, async () => {
    const urls: string[] = [];
    vi.stubGlobal(
        `fetch`,
        vi.fn(async (url: string) => {
            urls.push(url);
            return new Response(JSON.stringify({ replies: [{ seq: 3, at: 1, text: `a person wrote back` }], cursor: 3 }), { status: 200 });
        }),
    );
    const pending = await fetchPending(ENDPOINT, `v 1/2`, 2);
    expect(pending.replies).toEqual([{ seq: 3, at: 1, text: `a person wrote back` }]);
    expect(pending.cursor).toBe(3);
    // The conversation id is a stored value, not a literal: an unescaped one would address a different thread.
    expect(urls).toEqual([`https://sandbox-abc.example/webchat/support/messages?conversation=v%201%2F2&after=2`]);
});

test(`a refused poll carries the server's own sentence, so a misconfigured origin is legible`, async () => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(JSON.stringify({ error: `origin not allowed` }), { status: 403 })),
    );
    const error = await fetchPending(ENDPOINT, `v-1`, 0).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmbedError);
    expect((error as EmbedError).message).toBe(`origin not allowed`);
});
