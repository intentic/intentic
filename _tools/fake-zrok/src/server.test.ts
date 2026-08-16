import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ADMIN_TOKEN, type FakeZrok, NAMESPACE_TOKEN, startFakeZrok } from "./server.ts";

/* The three calls the platform makes, and the two refusals it has code to handle.
 *
 * The refusals are the tests worth having. A stand-in that answered everything would be green on exactly the
 * paths this exists to let run: the 401 the platform turns into a sentence naming its two settings, and the
 * duplicate-500 its create-retry was written for.
 */

const MEDIA_TYPE = `application/zrok.v1+json`;

let zrok: FakeZrok | undefined;

const start = async (): Promise<FakeZrok> => {
    zrok = await startFakeZrok();
    return zrok;
};

const call = async (hub: FakeZrok, method: string, path: string, body?: unknown, token = DEFAULT_ADMIN_TOKEN): Promise<Response> =>
    fetch(`${hub.endpoint}/api/v2${path}`, {
        method,
        headers: { "x-token": token, accept: MEDIA_TYPE, ...(body === undefined ? {} : { "content-type": MEDIA_TYPE }) },
        body: body === undefined ? null : JSON.stringify(body),
    });

afterEach(async () => {
    await zrok?.close();
    zrok = undefined;
});

describe(`the calls the platform makes`, () => {
    it(`names a public namespace, which is what the daemon attaches its own names under`, async () => {
        const hub = await start();

        const response = await call(hub, `GET`, `/namespaces`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([{ namespaceToken: NAMESPACE_TOKEN, name: `public`, open: true }]);
    });

    it(`mints one account per sandbox and remembers it`, async () => {
        const hub = await start();

        const response = await call(hub, `POST`, `/account`, { email: `sandbox-abc@zone.test`, password: `x` });

        expect(response.status).toBe(201);
        expect(((await response.json()) as { accountToken: string }).accountToken).toMatch(/.+/);
        expect(hub.accounts.has(`sandbox-abc@zone.test`)).toBe(true);
    });

    it(`removes an account, and answers a second removal the way a done job answers`, async () => {
        const hub = await start();
        await call(hub, `POST`, `/account`, { email: `sandbox-abc@zone.test`, password: `x` });

        expect((await call(hub, `DELETE`, `/account`, { email: `sandbox-abc@zone.test` })).status).toBe(200);
        // 404 — which the platform's client reads as success, so a retried removal cannot fail on it.
        expect((await call(hub, `DELETE`, `/account`, { email: `sandbox-abc@zone.test` })).status).toBe(404);
    });
});

describe(`the refusals the platform has code for`, () => {
    it(`refuses a wrong admin token with 401`, async () => {
        const hub = await start();

        // The one status the platform turns into a sentence naming ZROK_ADMIN_TOKEN and ZROK_API_ENDPOINT.
        expect((await call(hub, `GET`, `/namespaces`, undefined, `wrong`)).status).toBe(401);
    });

    it(`answers a duplicate account with 500, which is what the create-retry was written for`, async () => {
        const hub = await start();
        await call(hub, `POST`, `/account`, { email: `sandbox-abc@zone.test`, password: `x` });

        const again = await call(hub, `POST`, `/account`, { email: `sandbox-abc@zone.test`, password: `x` });

        expect(again.status).toBe(500);
    });
});

describe(`liveness`, () => {
    it(`answers /health without the admin token, so a readiness probe needs none`, async () => {
        const hub = await start();

        const response = await fetch(`${hub.endpoint}/health`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, accounts: 0 });
    });
});
