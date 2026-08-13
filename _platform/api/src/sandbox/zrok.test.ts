import { afterEach, describe, expect, it, vi } from "vitest";
import { accountEmail, createSandboxAccount, deleteSandboxAccount, publicNamespaceToken, ZrokError } from "./zrok.js";

const stubFetch = (routes: { match: (method: string, url: string) => boolean; respond: () => Response }[]) => {
    const calls: { method: string; url: string; body?: unknown; headers?: unknown }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
        const method = init?.method ?? `GET`;
        calls.push({
            method,
            url: String(url),
            headers: init?.headers,
            ...(typeof init?.body === `string` ? { body: JSON.parse(init.body) } : {}),
        });
        const route = routes.find((candidate) => candidate.match(method, String(url)));
        if (!route) {
            throw new Error(`unexpected fetch: ${method} ${String(url)}`);
        }
        return Promise.resolve(route.respond());
    });
    return calls;
};

const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });

const config = { apiEndpoint: `https://zrok2.sbx.test`, adminToken: `admin-token`, zone: `sbx.test` };

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`zrok`, () => {
    it(`mints one account per sandbox under the synthetic email, x-token authed, v2 path, hub media type`, async () => {
        const calls = stubFetch([
            { match: (method, url) => method === `POST` && url.endsWith(`/api/v2/account`), respond: () => json({ accountToken: `acct-1` }, 201) },
        ]);
        const created = await createSandboxAccount(config, { sandboxId: `abcdefabcdef`, password: `p` });
        expect(created).toEqual({ accountToken: `acct-1` });
        expect(calls[0]?.body).toEqual({ email: `sandbox-abcdefabcdef@sbx.test`, password: `p` });
        const headers = calls[0]?.headers as Record<string, string> | undefined;
        expect(headers?.[`x-token`]).toBe(`admin-token`);
        // The hub declares its OWN media type on every operation and answers `application/json` with a 500 that
        // reads like a server fault — the header is load-bearing, so it is asserted rather than assumed.
        expect(headers?.[`content-type`]).toBe(`application/zrok.v1+json`);
        expect(headers?.[`accept`]).toBe(`application/zrok.v1+json`);
    });

    /* A mint that collides is a mint whose row-write never landed: the hub has no way to read an existing
     * account's token back, so the only way out is to drop the stale account and mint again. */
    it(`heals a colliding mint by deleting the stale account and minting again`, async () => {
        let created = 0;
        const calls = stubFetch([
            {
                match: (method, url) => method === `POST` && url.endsWith(`/account`),
                respond: () => {
                    created += 1;
                    return created === 1 ? new Response(``, { status: 500 }) : json({ accountToken: `acct-2` }, 201);
                },
            },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 200 }) },
        ]);
        expect(await createSandboxAccount(config, { sandboxId: `abcdefabcdef`, password: `p` })).toEqual({ accountToken: `acct-2` });
        expect(calls.map((call) => call.method)).toEqual([`POST`, `DELETE`, `POST`]);
    });

    // A hub that is simply down must not read as a collision: the retry fails too, and the FIRST error is what
    // the operator sees.
    it(`surfaces the original failure when the retry fails as well`, async () => {
        stubFetch([
            { match: (method) => method === `POST`, respond: () => new Response(`boom`, { status: 502 }) },
            { match: (method) => method === `DELETE`, respond: () => new Response(``, { status: 404 }) },
        ]);
        await expect(createSandboxAccount(config, { sandboxId: `abcdefabcdef`, password: `p` })).rejects.toThrow(/HTTP 502/);
    });

    it(`treats an already-gone account as deleted, so a retried removal cannot fail on it`, async () => {
        stubFetch([{ match: (method) => method === `DELETE`, respond: () => new Response(`not found`, { status: 404 }) }]);
        await expect(deleteSandboxAccount(config, `abcdefabcdef`)).resolves.toBeUndefined();
    });

    it(`resolves the public namespace and refuses a hub whose bootstrap never ran`, async () => {
        stubFetch([
            {
                match: (method, url) => method === `GET` && url.endsWith(`/namespaces`),
                respond: () => json([{ namespaceToken: `ns-1`, name: `public`, open: true }]),
            },
        ]);
        expect(await publicNamespaceToken(config)).toBe(`ns-1`);
        vi.unstubAllGlobals();
        stubFetch([{ match: (method, url) => method === `GET` && url.endsWith(`/namespaces`), respond: () => json([]) }]);
        await expect(publicNamespaceToken(config)).rejects.toThrow(/bootstrap/);
    });

    it(`names the operator's problem on 401`, async () => {
        stubFetch([{ match: () => true, respond: () => new Response(``, { status: 401 }) }]);
        await expect(createSandboxAccount(config, { sandboxId: `a`, password: `p` })).rejects.toThrow(ZrokError);
        await expect(createSandboxAccount(config, { sandboxId: `a`, password: `p` })).rejects.toThrow(/ZROK_ADMIN_TOKEN/);
    });

    it(`derives the account email from the sandbox id alone`, () => {
        expect(accountEmail(`0f310c3c4db4`, `sbx.test`)).toBe(`sandbox-0f310c3c4db4@sbx.test`);
    });
});
