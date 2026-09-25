import http from "node:http";
import { forceSave, outcomeOf } from "./command.js";
import { verifyJwt } from "./jwt.js";

// The forced save against a stand-in command service on a real port: what it sends, signed how, and what each answer
// means to the viewer that asked.

const secret = `command-secret`;
let server: http.Server;
let port = 0;
const received: { path: string; body: Record<string, unknown>; claims: Record<string, unknown> | undefined }[] = [];
let answer: { status: number; body: string } = { status: 200, body: `{"error":0}` };

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on(`data`, (chunk: Buffer) => chunks.push(chunk));
        req.on(`end`, () => {
            const body = JSON.parse(Buffer.concat(chunks).toString(`utf8`)) as Record<string, unknown>;
            received.push({ path: req.url ?? ``, body, claims: verifyJwt(String(body[`token`]), secret) });
            res.writeHead(answer.status, { "content-type": `application/json` });
            res.end(answer.body);
        });
    });
    await new Promise<void>((resolve) => server.listen(0, `127.0.0.1`, resolve));
    const address = server.address();
    port = typeof address === `object` && address !== null ? address.port : 0;
});

afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
});

describe(`a forced save`, () => {
    it(`posts the command for the key to /command, signed in the body with the shared secret`, async () => {
        answer = { status: 200, body: `{"key":"k1","error":0}` };
        expect(await forceSave(port, `k1`, secret)).toBe(`started`);
        expect(received.at(-1)).toEqual({
            path: `/command`,
            body: { c: `forcesave`, key: `k1`, token: expect.any(String) },
            claims: { c: `forcesave`, key: `k1` },
        });
    });

    it(`reads the service's own codes, and anything else as refused`, async () => {
        answer = { status: 200, body: `{"key":"k1","error":4}` };
        expect(await forceSave(port, `k1`, secret)).toBe(`unchanged`);
        answer = { status: 200, body: `{"key":"k1","error":1}` };
        expect(await forceSave(port, `k1`, secret)).toBe(`no-session`);
        answer = { status: 500, body: `{}` };
        expect(await forceSave(port, `k1`, secret)).toBe(`refused`);
        expect(outcomeOf(6)).toBe(`refused`);
        expect(outcomeOf(undefined)).toBe(`refused`);
    });
});
