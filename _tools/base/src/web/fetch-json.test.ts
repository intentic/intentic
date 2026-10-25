import { answeringFetch, streamedResponse } from "./capped-read.testing.js";
import { FetchJsonError, fetchJson, fetchJsonResponse } from "./fetch-json.js";

test("a refused chunked body is cancelled before it is downloaded in full", async () => {
    const { response, pulled } = streamedResponse(100, 1024, 0x61, { status: 502 });
    const error = await fetchJson("https://upstream.test", { fetch: answeringFetch(() => response) }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(FetchJsonError);
    expect(error).toMatchObject({ kind: "status", status: 502, body: `${"a".repeat(300)}…` });
    expect(pulled.cancelled).toBe(true);
    expect(pulled.count).toBeLessThan(100);
});

test("an explicitly accepted refusal still returns its complete JSON body", async () => {
    const body = { error: "a".repeat(2048) };
    expect(await fetchJsonResponse("https://upstream.test", {
        accept: [404],
        fetch: answeringFetch(() => Response.json(body, { status: 404 })),
    })).toMatchObject({ status: 404, json: body });
});
