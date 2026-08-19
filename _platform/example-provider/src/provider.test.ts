import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProvider } from "./provider.js";

/* What is pinned here is the provider CONTRACT as this reference implements it: signed calls served, forged
 * and replayed calls refused, and each scenario answering the shape the platform's forward expects. The
 * platform-side proof — the REAL admission probe and a REAL metered run driven against this very handler —
 * lives in the api package (pool-conformance.test.ts), where the real forward and probe are importable. */

const SECRET = `example-secret`;
const NOW = new Date(`2026-08-10T12:00:00Z`);

const signed = (body: string, at: Date = NOW): Request => {
    const timestamp = String(Math.floor(at.getTime() / 1000));
    const signature = createHmac(`sha256`, SECRET).update(`${timestamp}.${body}`).digest(`hex`);
    return new Request(`https://svc.example.test/run`, {
        method: `POST`,
        body,
        headers: { "content-type": `application/json`, "x-intentic-timestamp": timestamp, "x-intentic-signature": signature },
    });
};

const provider = () => createProvider({ secret: SECRET, now: () => NOW });

const linesOf = async (response: Response) =>
    (await response.text())
        .trim()
        .split(`\n`)
        .map((line) => JSON.parse(line) as { event: string; data?: { example?: boolean; query?: string } });

describe(`the example provider`, () => {
    it(`serves a signed run: status lines, then the one result`, async () => {
        const response = await provider().fetch(signed(`{"query":"launch on reddit","paceMs":0}`));
        expect(response.status).toBe(200);
        expect(response.headers.get(`content-type`)).toBe(`application/x-ndjson`);
        const lines = await linesOf(response);
        expect(lines.map((line) => line.event)).toEqual([`status`, `status`, `result`]);
        expect(lines.at(-1)?.data).toMatchObject({ example: true, query: `launch on reddit` });
    });

    it(`refuses a forged signature`, async () => {
        const body = `{"query":"x"}`;
        const request = new Request(`https://svc.example.test/run`, {
            method: `POST`,
            body,
            headers: { "x-intentic-timestamp": String(Math.floor(NOW.getTime() / 1000)), "x-intentic-signature": `0`.repeat(64) },
        });
        expect((await provider().fetch(request)).status).toBe(401);
    });

    it(`refuses a replay: a correctly-signed call whose timestamp died of old age`, async () => {
        const stale = new Date(NOW.getTime() - 3_600_000);
        expect((await provider().fetch(signed(`{"query":"x"}`, stale))).status).toBe(401);
    });

    it(`refuses an unsigned call outright`, async () => {
        const request = new Request(`https://svc.example.test/run`, { method: `POST`, body: `{}` });
        expect((await provider().fetch(request)).status).toBe(401);
    });

    it(`answers health without a signature — it is for the provider's own uptime checks`, async () => {
        const response = await provider().fetch(new Request(`https://svc.example.test/healthz`));
        expect(response.status).toBe(200);
    });

    it(`scenario "refuse" is a complete 4xx answer; "fail" a 5xx; "broken" a stream with no result`, async () => {
        expect((await provider().fetch(signed(`{"scenario":"refuse"}`))).status).toBe(400);
        expect((await provider().fetch(signed(`{"scenario":"fail"}`))).status).toBe(500);
        const broken = await provider().fetch(signed(`{"scenario":"broken","paceMs":0}`));
        expect(broken.status).toBe(200);
        expect((await linesOf(broken)).map((line) => line.event)).toEqual([`status`, `status`]);
    });
});
