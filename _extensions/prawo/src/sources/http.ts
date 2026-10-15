import { fetchJsonResponse } from "@intentic/base/fetch-json";
import type { z } from "zod";

/* THE ONE WAY OUT TO THE PUBLIC SOURCES. Every call names itself to the server and carries a deadline; tests hand in a
   fetch of their own instead of the network. */

const USER_AGENT = "intentic-prawo/1.0 (+https://intentic.dev)";
const JSON_TIMEOUT_MS = 30_000;
// A consolidated code is a PDF of a few hundred pages; the Sejm's server sends one in seconds, a slow link in more.
const DOCUMENT_TIMEOUT_MS = 120_000;

export interface Http {
    // The body parsed and checked against what the API documents, so a changed shape fails here and not three calls on.
    json<T>(url: string, schema: z.ZodType<T>): Promise<T>;
    bytes(url: string): Promise<Uint8Array>;
    text(url: string): Promise<string>;
}

export const createHttp = (call: typeof fetch = fetch): Http => {
    const get = async (url: string): Promise<Response> => {
        const response = await call(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`GET ${url} failed (HTTP ${String(response.status)})`);
        }
        return response;
    };
    return {
        json: async (url, schema) =>
            schema.parse((await fetchJsonResponse(url, { headers: { "user-agent": USER_AGENT }, timeoutMs: JSON_TIMEOUT_MS, fetch: call })).json),
        bytes: async (url) => new Uint8Array(await (await get(url)).arrayBuffer()),
        text: async (url) => await (await get(url)).text(),
    };
};
