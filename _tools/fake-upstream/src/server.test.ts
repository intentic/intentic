import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REPLY, type FakeUpstream, startFakeUpstream } from "./server.ts";

// Trial requests asserted against the CI stand-in. The valuable tests are refusals: the platform hits two surfaces with
// two different credentials, and this fake must reject the wrong one on either, not answer everything.

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
            // Prefixed on purpose: an unprefixed id here would let a broken bareId ship undetected.
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
        // Echoed, not fixed: a wrong id from the picker would otherwise still look right.
        expect(body.model).toBe(`fake-flash-latest`);
        // Proves the prompt reached upstream; a rendered reply alone doesn't cover that half.
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
        // Missing this reads as no model being chattable, silently falling back to the floor.
        expect(body.models[0]?.supportedGenerationMethods).toContain(`generateContent`);
    });

    it(`refuses a bearer the way Google refuses one`, async () => {
        const fake = await start();

        // Valid credential, wrong dialect: the real upstream answers 401 rather than falling back to an API key check.
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

        // 429 is what poolRefused reads as try the next key, not tell the user no.
        expect(refused.status).toBe(429);
        expect(served.status).toBe(200);
        // Both recorded: proof the pool actually walked to the next key, not gave up.
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
