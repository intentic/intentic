import { readBoundedBytes, readBoundedJson, readBoundedText } from "./bounded-body.js";

// A body that declares no length, the way a chunked request arrives.
const chunked = (...parts: string[]): Request => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const part of parts) {
                controller.enqueue(encoder.encode(part));
            }
            controller.close();
        },
    });
    // SAFETY: `duplex` is required by the runtime for a stream body but missing from the DOM RequestInit type.
    return new Request("http://local/x", { method: "POST", body, duplex: "half" } as RequestInit);
};

test("a declared length over the limit is refused before anything is read", async () => {
    const request = new Request("http://local/x", { method: "POST", body: "{}", headers: { "content-length": "100" } });
    expect(await readBoundedJson(request, 10)).toEqual({ kind: "tooLarge" });
});

test("a chunked body that declares nothing is still cut at the limit", async () => {
    expect(await readBoundedText(chunked("a".repeat(8), "b".repeat(8)), 10)).toEqual({ kind: "tooLarge" });
});

test("a body within the limit parses, whether chunked or declared", async () => {
    expect(await readBoundedJson(chunked('{"a":', "1}"), 64)).toEqual({ kind: "ok", value: { a: 1 } });
    expect(await readBoundedJson(new Request("http://local/x", { method: "POST", body: '{"b":2}' }), 64)).toEqual({ kind: "ok", value: { b: 2 } });
});

test("JSON that does not parse and bytes that are not UTF-8 are invalid, not too large", async () => {
    expect(await readBoundedJson(chunked("{nope"), 64)).toEqual({ kind: "invalid" });
    const notText = new Request("http://local/x", { method: "POST", body: new Uint8Array([0xff, 0xfe, 0xfd]) });
    expect(await readBoundedText(notText, 64)).toEqual({ kind: "invalid" });
});

test("an absent body reads as empty", async () => {
    const read = await readBoundedBytes(new Request("http://local/x"), 10);
    expect(read.kind === "ok" ? read.value.byteLength : -1).toBe(0);
});
