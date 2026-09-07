import type { IncomingMessage, ServerResponse } from "node:http";

/* THE TWO LINES EVERY FAKE HTTP SERVER IN THIS REPO WRITES. The fakes stand in for real upstreams (a model
 * endpoint, the platform's API) and each one is a bare `node:http` server on purpose — a framework in a test
 * double is a second thing that can be the reason a test fails. What that costs is the request-body read and
 * the JSON reply, which every fake then wrote for itself. They are here so a fake is only the part that is
 * ABOUT the upstream it imitates. */

// The whole request body as text. Fakes answer small, scripted payloads, so buffering is the right shape:
// a fake that streamed its input would be testing node's stream plumbing rather than the caller's request.
export const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

/* A JSON reply with an explicit `content-length`. The length matters: a client that reads to EOF cannot tell
 * a complete short answer from a connection that died mid-body, and a fake whose refusals are indistinguishable
 * from a dropped socket is a fake that makes retry logic untestable. */
export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
};
