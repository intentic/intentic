import { afterEach, describe, expect, it, vi } from "vitest";
import { FlyError } from "./fly.js";
import { mintAppDeployToken, organizationIdOf, revokeDeployToken } from "./fly-tokens.js";

// The one GraphQL endpoint, stubbed: every call records what it sent and answers what the case says.
const stubGraphql = (answer: (body: { query: string; variables: Record<string, unknown> }) => unknown, status = 200) => {
    const calls: { query: string; variables: Record<string, unknown>; headers: Record<string, string> }[] = [];
    vi.stubGlobal(`fetch`, (url: URL | string, init?: RequestInit): Promise<Response> => {
        expect(String(url)).toBe(`https://api.fly.io/graphql`);
        const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
        calls.push({ ...body, headers: init?.headers as Record<string, string> });
        return Promise.resolve(new Response(JSON.stringify(answer(body)), { status }));
    });
    return calls;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(`fly deploy tokens`, () => {
    it(`looks the organization's node id up by its slug`, async () => {
        const calls = stubGraphql(() => ({ data: { organization: { id: `org-node` } } }));
        expect(await organizationIdOf(`fly`, `intentic`)).toBe(`org-node`);
        expect(calls[0]?.variables).toEqual({ slug: `intentic` });
        expect(calls[0]?.headers[`authorization`]).toBe(`Bearer fly`);
    });

    it(`names a missing organization as the config's fault`, async () => {
        stubGraphql(() => ({ data: { organization: null } }));
        await expect(organizationIdOf(`fly`, `nobody`)).rejects.toThrow(/HOSTED_FLY_ORG/);
    });

    // The token's scope is the whole safety argument: one app, the deploy profile, minutes rather than years.
    it(`mints a deploy token scoped to exactly one app, expiring in minutes`, async () => {
        const calls = stubGraphql(() => ({ data: { createLimitedAccessToken: { limitedAccessToken: { id: `lat-1`, token: `fm2_secret` } } } }));
        const minted = await mintAppDeployToken(`fly`, `org-node`, { app: `intentic-sbx-abc`, name: `intentic overlay build b1`, expiryMinutes: 45 });
        expect(minted).toEqual({ id: `lat-1`, token: `fm2_secret` });
        expect(calls[0]?.variables).toEqual({
            input: {
                name: `intentic overlay build b1`,
                organizationId: `org-node`,
                profile: `deploy`,
                profileParams: { app_id: `intentic-sbx-abc` },
                expiry: `45m`,
            },
        });
    });

    it(`revokes by the token's id`, async () => {
        const calls = stubGraphql(() => ({ data: { deleteLimitedAccessToken: { token: `x` } } }));
        await revokeDeployToken(`fly`, `lat-1`);
        expect(calls[0]?.variables).toEqual({ input: { id: `lat-1` } });
    });

    it(`surfaces Fly's own refusal, and a rejected credential as the config's fault`, async () => {
        stubGraphql(() => ({ errors: [{ message: `Not authorized to access this app` }] }));
        await expect(organizationIdOf(`fly`, `intentic`)).rejects.toThrow(`Fly refused: Not authorized to access this app`);
        vi.unstubAllGlobals();
        stubGraphql(() => ({}), 401);
        await expect(organizationIdOf(`bad`, `intentic`)).rejects.toThrow(FlyError);
    });
});
