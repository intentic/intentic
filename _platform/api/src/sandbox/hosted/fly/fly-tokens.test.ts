import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { FlyError } from "./fly.js";
import { mintAppDeployToken, revokeDeployToken } from "./fly-tokens.js";

afterEach(() => {
    unstubAllGlobals();
});

describe(`fly deploy tokens`, () => {
    // Org deploy credentials can create this token through Machines, but GraphQL refuses createLimitedAccessToken.
    it(`uses the app's Machines endpoint with an explicit short expiry and keeps the returned token intact`, async () => {
        const fetch = jest.fn().mockImplementation((url: URL | string, init?: RequestInit) => {
            expect(String(url)).toBe(`https://api.machines.dev/v1/apps/intentic-sbx-abc/deploy_token`);
            expect(init?.method).toBe(`POST`);
            expect(new Headers(init?.headers).get(`authorization`)).toBe(`Bearer org-token`);
            expect(JSON.parse(String(init?.body))).toEqual({ expiry: `45m` });
            return Promise.resolve(new Response(JSON.stringify({ token: `FlyV1 fm2_app` })));
        });
        stubGlobal(`fetch`, fetch);
        expect(await mintAppDeployToken(`org-token`, { app: `intentic-sbx-abc`, expiryMinutes: 45 })).toBe(`FlyV1 fm2_app`);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it.each([401, 403, 503])(`preserves an HTTP %s refusal as a Fly error`, async (status) => {
        stubGlobal(`fetch`, () => Promise.resolve(new Response(JSON.stringify({ error: `refused` }), { status })));
        const error = await mintAppDeployToken(`bad`, { app: `app`, expiryMinutes: 45 }).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(FlyError);
        expect((error as FlyError).status).toBe(status);
        if (status !== 503) {
            expect((error as FlyError).message).toContain(`HOSTED_FLY_API_TOKEN`);
        }
    });

    it.each([{}, { token: `` }])(`rejects a successful response without a usable token: %j`, async (body) => {
        stubGlobal(`fetch`, () => Promise.resolve(new Response(JSON.stringify(body))));
        await expect(mintAppDeployToken(`fly`, { app: `app`, expiryMinutes: 45 })).rejects.toThrow();
    });

    it(`still revokes legacy GraphQL tokens by id`, async () => {
        stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
            expect(String(url)).toBe(`https://api.fly.io/graphql`);
            const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
            expect(body.query).toContain(`deleteLimitedAccessToken`);
            expect(body.variables).toEqual({ input: { id: `lat-1` } });
            return Promise.resolve(new Response(JSON.stringify({ data: { deleteLimitedAccessToken: { token: `x` } } })));
        });
        await revokeDeployToken(`fly`, `lat-1`);
    });
});
