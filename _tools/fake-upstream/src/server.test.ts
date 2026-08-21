import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REPLY, type FakeUpstream, startFakeUpstream } from "./server.ts";

/* What the platform's trial actually sends, asserted against the stand-in that will answer it in CI.
 *
 * The tests worth having here are the REFUSALS. A fake that answers everything is a fake that goes green on the
 * mix-up it was built to catch: the platform asks two surfaces with two different credentials, and sending the
 * wrong one to either is the failure this package exists to make visible. */

let upstream: FakeUpstream | undefined;

const start = async (options: Parameters<typeof startFakeUpstream>[0] = {}): Promise<FakeUpstream> => {
    upstream = await startFakeUpstream(options);
    return upstream;
};

// The native listing sits one segment up from the base, exactly as `nativeModelsUrl` derives it.
const nativeUrl = (fake: FakeUpstream): string => `${fake.baseUrl.slice(0, -`/openai`.length)}/models?pageSize=1000`;

afterEach(async () => {
    await upstream?.close();
    upstream = undefined;
});

describe(`the OpenAI-compatible surface`, () => {
    it(`lists models to a bearer, prefixed the way Google prefixes them`, async () => {
        const fake = await start({ models: [`alpha`, `beta`] });

        const response = await fetch(`${fake.baseUrl}/models`, { headers: { authorization: `Bearer key-1` } });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            object: `list`,
            // `models/` prefixed, so the platform's own strip runs instead of being made unnecessary by a
            // helpful fake. An unprefixed id here would let a broken `bareId` ship.
            data: [
                { id: `models/alpha`, object: `model` },
                { id: `models/beta`, object: `model` },
            ],
        });
    });

    it(`refuses a request with no bearer`, async () => {
        const fake = await start();

        const response = await fetch(`${fake.baseUrl}/models`);

        expect(response.status).toBe(401);
    });

    it(`answers a chat and hands back the reply a browser will read`, async () => {
        const fake = await start();

        const response = await fetch(`${fake.baseUrl}/chat/completions`, {
            method: `POST`,
            headers: { authorization: `Bearer key-1`, "content-type": `application/json` },
            body: JSON.stringify({ model: `fake-flash-latest`, messages: [{ role: `user`, content: `hi` }] }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as { choices: { message: { content: string } }[]; model: string };
        expect(body.choices[0]?.message.content).toBe(DEFAULT_REPLY);
        // Echoed rather than fixed: a picker that sent the wrong id would otherwise look right in the answer.
        expect(body.model).toBe(`fake-flash-latest`);
        // The prompt reached the upstream, which is the half of the pipe a rendered reply alone does not prove.
        expect(fake.received).toHaveLength(1);
        expect(fake.received[0]).toContain(`hi`);
    });

    it(`streams SSE frames when the request asks for them`, async () => {
        const fake = await start({ reply: `streamed words` });

        const response = await fetch(`${fake.baseUrl}/chat/completions`, {
            method: `POST`,
            headers: { authorization: `Bearer key-1`, "content-type": `application/json` },
            body: JSON.stringify({ model: `fake-flash-latest`, stream: true, messages: [] }),
        });

        expect(response.headers.get(`content-type`)).toBe(`text/event-stream`);
        const text = await response.text();
        expect(text).toContain(`"content":"streamed words"`);
        expect(text).toContain(`"finish_reason":"stop"`);
        expect(text.trimEnd().endsWith(`data: [DONE]`)).toBe(true);
    });
});

describe(`Google's own surface beside it`, () => {
    it(`publishes the capability the trial's catalog filters on`, async () => {
        const fake = await start({ models: [`alpha`] });

        const response = await fetch(nativeUrl(fake), { headers: { "x-goog-api-key": `key-1` } });

        expect(response.status).toBe(200);
        const body = (await response.json()) as { models: { name: string; supportedGenerationMethods: string[] }[] };
        expect(body.models[0]?.name).toBe(`models/alpha`);
        // Without this the platform reads every model as un-chattable and serves the floor instead: the exact
        // silent emptying the catalog's floor exists to survive.
        expect(body.models[0]?.supportedGenerationMethods).toContain(`generateContent`);
    });

    it(`refuses a bearer the way Google refuses one`, async () => {
        const fake = await start();

        // THE BUG THIS PACKAGE EXISTS TO CATCH. The credential is valid; the dialect is not, and the real
        // upstream answers 401 rather than falling back to looking for an api key.
        const response = await fetch(nativeUrl(fake), { headers: { authorization: `Bearer key-1` } });

        expect(response.status).toBe(401);
        expect(JSON.stringify(await response.json())).toContain(`OAuth 2 access token`);
    });

    it(`refuses a request carrying no key at all`, async () => {
        const fake = await start();

        expect((await fetch(nativeUrl(fake))).status).toBe(401);
    });
});

describe(`the refusing keys`, () => {
    it(`answers 429 so the platform's pool walks past them to one that serves`, async () => {
        const fake = await start({ refuseKeys: [`spent`] });

        const refused = await fetch(`${fake.baseUrl}/chat/completions`, {
            method: `POST`,
            headers: { authorization: `Bearer spent`, "content-type": `application/json` },
            body: JSON.stringify({ messages: [] }),
        });
        const served = await fetch(`${fake.baseUrl}/chat/completions`, {
            method: `POST`,
            headers: { authorization: `Bearer fresh`, "content-type": `application/json` },
            body: JSON.stringify({ messages: [] }),
        });

        // 429 is what the platform's `poolRefused` reads as "try the next key" rather than "tell the user no".
        expect(refused.status).toBe(429);
        expect(served.status).toBe(200);
        // Both attempts recorded, which is how a test asserts the pool actually walked rather than gave up.
        expect(fake.received).toHaveLength(2);
    });
});

describe(`liveness`, () => {
    it(`answers /health without a credential, so a readiness probe needs none`, async () => {
        const fake = await start({ models: [`alpha`] });

        const response = await fetch(`http://127.0.0.1:${fake.port}/health`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, models: [`alpha`] });
    });

    it(`names an unknown route rather than answering it`, async () => {
        const fake = await start();

        const response = await fetch(`${fake.baseUrl}/embeddings`, { headers: { authorization: `Bearer key-1` } });

        expect(response.status).toBe(404);
    });
});
