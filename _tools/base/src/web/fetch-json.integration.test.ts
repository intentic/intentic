import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bodyExcerpt, FetchJsonError, fetchJson, fetchJsonResponse } from "./fetch-json.js";

// A real loopback server: a deadline and a refused connection are transport facts no stubbed fetch reproduces.

let server: Server;
let base: string;

beforeAll(async () => {
    server = createServer((request, response) => {
        if (request.url === "/ok") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ hello: "world" }));
        } else if (request.url === "/echo") {
            let body = "";
            request.on("data", (chunk: Buffer) => (body += chunk.toString()));
            request.on("end", () => response.end(JSON.stringify({ method: request.method, type: request.headers["content-type"], body })));
        } else if (request.url === "/empty") {
            response.statusCode = 204;
            response.end();
        } else if (request.url === "/refused") {
            response.statusCode = 502;
            response.end(`<html>${"x".repeat(1000)}</html>`);
        } else if (request.url === "/not-json") {
            response.end("plain words");
        }
        // "/stall" never answers.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
    server.closeAllConnections();
    server.close();
});

const failure = async (call: Promise<unknown>): Promise<FetchJsonError> => {
    const thrown: unknown = await call.then(
        () => undefined,
        (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(FetchJsonError);
    // SAFETY: checked by the instanceof assertion above.
    return thrown as FetchJsonError;
};

test("answers the parsed body", async () => {
    expect(await fetchJson(`${base}/ok`)).toEqual({ hello: "world" });
});

test("sends a json body with its content type", async () => {
    expect(await fetchJson(`${base}/echo`, { method: "POST", json: { a: 1 } })).toEqual({ method: "POST", type: "application/json", body: `{"a":1}` });
});

test("answers undefined for an empty body, with its status", async () => {
    expect(await fetchJsonResponse(`${base}/empty`)).toMatchObject({ status: 204, json: undefined });
});

test("a refusal carries its status and a bounded excerpt of the body", async () => {
    const error = await failure(fetchJson(`${base}/refused`, { label: "probe" }));
    expect(error).toMatchObject({ kind: "status", status: 502 });
    expect(error.body?.length).toBe(301);
    expect(error.message.startsWith("probe failed (HTTP 502): <html>xxx")).toBe(true);
});

test("an accepted status is answered rather than thrown", async () => {
    expect(await fetchJsonResponse(`${base}/refused`, { accept: [502] })).toMatchObject({ status: 502 });
});

test("a body that is not JSON is a parse failure", async () => {
    expect(await failure(fetchJson(`${base}/not-json`))).toMatchObject({ kind: "parse", status: 200 });
});

test("its own deadline is a timeout, not a transport failure", async () => {
    const error = await failure(fetchJson(`${base}/stall`, { timeoutMs: 100, label: "stall" }));
    expect(error).toMatchObject({ kind: "timeout", message: "stall timed out after 100ms" });
});

test("the caller's abort is told apart from the deadline", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await failure(fetchJson(`${base}/stall`, { signal: controller.signal, timeoutMs: 10_000 }))).toMatchObject({ kind: "aborted" });
});

test("a server that is not there is a transport failure", async () => {
    // Port 1 on loopback: nothing listens, so the connection is refused at once.
    expect(await failure(fetchJson("http://127.0.0.1:1/x"))).toMatchObject({ kind: "transport" });
});

test("bodyExcerpt flattens whitespace and cuts at its limit", () => {
    expect(bodyExcerpt("a\n  b", 10)).toBe("a b");
    expect(bodyExcerpt("abcdef", 3)).toBe("abc…");
});
