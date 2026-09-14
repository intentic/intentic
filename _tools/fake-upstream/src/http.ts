import type { IncomingMessage, ServerResponse } from "node:http";

/* THE REQUEST-BODY READ AND THE JSON REPLY, OWNED HERE RATHER THAN IMPORTED, and that is the whole point of this file. */

// The whole request body as text. Fakes answer small, scripted payloads, so buffering is the right shape:
// a fake that streamed its input would be testing node's stream plumbing rather than the caller's request.
export const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

/* A JSON reply with an explicit `content-length`. */
export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
};
