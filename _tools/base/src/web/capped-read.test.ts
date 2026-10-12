import { readCappedBytes, readCappedText } from "./capped-read.js";
import { streamedResponse } from "./capped-read.testing.js";

describe("readCappedBytes", () => {
    it("cuts a streamed body over the cap at the cap, says so, and stops pulling", async () => {
        const { response, pulled } = streamedResponse(100, 1000);
        expect(response.headers.get("content-length")).toBeNull();

        const read = await readCappedBytes(response, 2500);

        expect(read.truncated).toBe(true);
        expect(read.bytes.byteLength).toBe(2500);
        expect(pulled.cancelled).toBe(true);
        // The chunk that crossed the cap, and at most the one the stream queued ahead of it.
        expect(pulled.count).toBeLessThanOrEqual(4);
    });

    it("returns a body under the cap whole", async () => {
        const { response, pulled } = streamedResponse(3, 1000, 0x62);

        const read = await readCappedBytes(response, 5000);

        expect(read).toEqual({ bytes: new Uint8Array(3000).fill(0x62), truncated: false });
        expect(pulled.cancelled).toBe(false);
    });

    it("keeps a body of exactly the cap whole", async () => {
        const { response } = streamedResponse(2, 1000);

        const read = await readCappedBytes(response, 2000);

        expect(read.truncated).toBe(false);
        expect(read.bytes.byteLength).toBe(2000);
    });

    it("reads an absent body as empty", async () => {
        expect(await readCappedBytes(new Response(null, { status: 204 }), 10)).toEqual({ bytes: new Uint8Array(), truncated: false });
    });
});

describe("readCappedText", () => {
    it("decodes a body under the cap as UTF-8", async () => {
        expect(await readCappedText(new Response("zł€"), 100)).toEqual({ text: "zł€", truncated: false });
    });

    it("reports a body over the cap", async () => {
        const { response } = streamedResponse(10, 100);

        const read = await readCappedText(response, 250);

        expect(read).toEqual({ text: "a".repeat(250), truncated: true });
    });
});

describe("readCappedBytes with a time limit", () => {
    it("stops reading once the time is up and keeps what arrived, marked truncated", async () => {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                pulls += 1;
                await new Promise((resolve) => setTimeout(resolve, 20));
                controller.enqueue(new Uint8Array(10));
            },
        });

        const read = await readCappedBytes(new Response(body), 1_000_000, { timeoutMs: 50 });

        expect(read.truncated).toBe(true);
        expect(read.bytes.byteLength).toBeGreaterThan(0);
        expect(pulls).toBeLessThan(10);
    });
});
