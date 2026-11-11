import { CONNECT_TOKEN_HEADER } from "@intentic/api-contract";
import { call, ORPCError } from "@orpc/server";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { emailOfIdToken, type Http } from "./google-connect.js";
import { googleConnectDoor, googleConnectRoutes } from "./google-connect.routes.js";

// Connect Google: the secret stays here, the consent asks for a lasting grant bound to the editor's PKCE verifier, and
// a refusal reaches the sandbox as Google's own code so its CLI can say what the owner does about it.

const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };
// SAFETY: these routes read only webOrigin and googleWorkspace off the config.
const config = {
    webOrigin: `https://app.example`,
    googleWorkspace: { clientId: `client-1.apps.googleusercontent.com`, clientSecret: `shh` },
} as Config;

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    // SAFETY: these routes read only the config and the user off the context.
    ({ config, user, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, headers: new Headers(), ...overrides }) as OrpcContext;

const CHALLENGE = `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`;
const VERIFIER = `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`;
const begin = { access: `write` as const, state: `state-0123456789abcdef`, codeChallenge: CHALLENGE, loginHint: `owner@example.com` };

const idToken = (claims: object): string => `h.${Buffer.from(JSON.stringify(claims)).toString(`base64url`)}.sig`;

const googleAnswers = (status: number, body: object) =>
    jest.fn<Http>().mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe(`begin`, () => {
    it(`asks for a lasting grant on the card's scopes, bound to the editor's PKCE challenge`, async () => {
        const { url } = await call(googleConnectRoutes().begin, begin, { context: context() });
        const asked = new URL(url);
        expect(asked.origin + asked.pathname).toBe(`https://accounts.google.com/o/oauth2/v2/auth`);
        expect(Object.fromEntries(asked.searchParams)).toMatchObject({
            client_id: `client-1.apps.googleusercontent.com`,
            redirect_uri: `https://app.example/oauth/google.html`,
            access_type: `offline`,
            prompt: `consent`,
            code_challenge: CHALLENGE,
            code_challenge_method: `S256`,
            state: begin.state,
            login_hint: `owner@example.com`,
        });
        const scopes = asked.searchParams.get(`scope`)?.split(` `) ?? [];
        expect(scopes).toEqual(expect.arrayContaining([`openid`, `email`, `https://www.googleapis.com/auth/gmail.modify`]));
        // The secret never rides a URL a browser holds.
        expect(url).not.toContain(`shh`);
    });

    it(`asks only for read scopes on a read-only card`, async () => {
        const { url } = await call(googleConnectRoutes().begin, { ...begin, access: `read` }, { context: context() });
        const scopes = new URL(url).searchParams.get(`scope`) ?? ``;
        expect(scopes).toContain(`gmail.readonly`);
        expect(scopes).not.toContain(`gmail.modify`);
    });

    it(`refuses without a session, and 404s on a platform with no client`, async () => {
        await expect(call(googleConnectRoutes().begin, begin, { context: context({ user: null }) })).rejects.toBeInstanceOf(ORPCError);
        const bare = context({ config: { ...config, googleWorkspace: { clientId: ``, clientSecret: `` } } });
        await expect(call(googleConnectRoutes().begin, begin, { context: bare })).rejects.toMatchObject({ code: `NOT_FOUND` });
    });
});

describe(`finish`, () => {
    it(`trades the code with the secret and the verifier, and answers the grant with the address it was made as`, async () => {
        const http = googleAnswers(200, {
            access_token: `at`,
            refresh_token: `rt-1`,
            scope: `openid https://www.googleapis.com/auth/gmail.modify`,
            id_token: idToken({ email: `owner@example.com` }),
        });
        const grant = await call(googleConnectRoutes(http).finish, { code: `c-1`, codeVerifier: VERIFIER }, { context: context() });
        expect(grant).toEqual({ refreshToken: `rt-1`, email: `owner@example.com`, scopes: [`openid`, `https://www.googleapis.com/auth/gmail.modify`] });
        const form = new URLSearchParams(String(http.mock.calls[0]?.[1].body));
        expect(Object.fromEntries(form)).toMatchObject({
            grant_type: `authorization_code`,
            client_secret: `shh`,
            code: `c-1`,
            code_verifier: VERIFIER,
            redirect_uri: `https://app.example/oauth/google.html`,
        });
    });

    it(`says to connect again when Google answers without a refresh token or refuses the code`, async () => {
        const none = googleAnswers(200, { access_token: `at` });
        await expect(call(googleConnectRoutes(none).finish, { code: `c`, codeVerifier: VERIFIER }, { context: context() })).rejects.toMatchObject({
            code: `BAD_REQUEST`,
            message: expect.stringContaining(`connect again`),
        });
        const used = googleAnswers(400, { error: `invalid_grant`, error_description: `Bad Request` });
        await expect(call(googleConnectRoutes(used).finish, { code: `c`, codeVerifier: VERIFIER }, { context: context() })).rejects.toMatchObject({
            code: `BAD_REQUEST`,
            message: expect.stringContaining(`expired or was already used`),
        });
    });
});

describe(`POST /google-connect/access-token`, () => {
    const known = (found: boolean) => jest.fn<(token: string) => Promise<boolean>>().mockResolvedValue(found);

    const ask = (app: ReturnType<typeof googleConnectDoor>, token: string | undefined, body: object) => {
        const headers = new Headers({ "content-type": `application/json` });
        if (token !== undefined) {
            headers.set(CONNECT_TOKEN_HEADER, token);
        }
        return app.request(`/access-token`, { method: `POST`, headers, body: JSON.stringify(body) });
    };

    it(`trades a known sandbox's refresh token for an hour of access`, async () => {
        const http = googleAnswers(200, { access_token: `at-1`, expires_in: 3599 });
        const res = await ask(googleConnectDoor({ config, sandboxKnown: known(true), http }), `tok`, { refreshToken: `rt-1` });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ accessToken: `at-1`, expiresIn: 3599 });
        expect(new URLSearchParams(String(http.mock.calls[0]?.[1].body)).get(`client_secret`)).toBe(`shh`);
    });

    it(`relays Google's own refusal code, and refuses a sandbox it does not know`, async () => {
        const revoked = googleAnswers(400, { error: `invalid_grant`, error_description: `Token has been expired or revoked.` });
        const res = await ask(googleConnectDoor({ config, sandboxKnown: known(true), http: revoked }), `tok`, { refreshToken: `rt-1` });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: `invalid_grant` });

        const http = googleAnswers(200, { access_token: `at` });
        expect((await ask(googleConnectDoor({ config, sandboxKnown: known(false), http }), `tok`, { refreshToken: `rt` })).status).toBe(404);
        expect((await ask(googleConnectDoor({ config, sandboxKnown: known(true), http }), undefined, { refreshToken: `rt` })).status).toBe(400);
        expect(http).not.toHaveBeenCalled();
    });
});

describe(`emailOfIdToken`, () => {
    it(`reads the address, and answers empty for anything else`, () => {
        expect(emailOfIdToken(idToken({ email: `a@b.c` }))).toBe(`a@b.c`);
        expect(emailOfIdToken(idToken({ sub: `1` }))).toBe(``);
        expect(emailOfIdToken(`not-a-jwt`)).toBe(``);
        expect(emailOfIdToken(undefined)).toBe(``);
    });
});
