import { type JsonObject, JsonObjectSchema, type JsonValue } from "./json.js";

// A fetch double for the client suites: records every request and answers through the suite's own function, so a test
// says exactly what the office would have answered and asserts on exactly what was sent. Nothing leaves the process.

export interface Call {
    readonly url: URL;
    readonly init: RequestInit | undefined;
}

export interface Recorder {
    readonly calls: Call[];
    readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;
}

export const recorder = (answer: (call: Call) => Response | Promise<Response>): Recorder => {
    const calls: Call[] = [];
    return {
        calls,
        fetcher: async (url, init) => {
            const call = { url: new URL(url), init };
            calls.push(call);
            return answer(call);
        },
    };
};

export const json = (body: JsonValue, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const header = (call: Call | undefined, name: string): string | null => new Headers(call?.init?.headers).get(name);

export const bodyOf = (call: Call | undefined): JsonObject => JsonObjectSchema.parse(JSON.parse(String(call?.init?.body)));
