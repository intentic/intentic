import type { IncomingMessage, ServerResponse } from "node:http";

// The two helpers every fake HTTP server in this repo needs: reading the request body and sending a JSON reply. Fakes
// are bare `node:http` servers, not a framework, so a fake stays only the part that's about the upstream it imitates.

// Buffers the whole body as text; fakes only see small scripted payloads, so there's no need to stream.
export const readBody = async (request: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

// Sends JSON with an explicit `content-length`, so a client can tell a complete short reply from a connection that died
// mid-body.
export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    response.end(text);
};
