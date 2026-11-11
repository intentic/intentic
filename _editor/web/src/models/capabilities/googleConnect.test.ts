import { createHash } from "node:crypto";
import {
    accessOf,
    challengeOf,
    GoogleCallbackSchema,
    grantCovers,
    grantedAccess,
    makeState,
    makeVerifier,
    readCallback,
    signsIn,
} from "./googleConnect";

const tokenField = { key: `refreshToken`, label: `Google account`, secret: true, signIn: `google` as const };

it(`stands in for the token field while the card uses the platform's client, and gives the box back for an own client`, () => {
    expect(signsIn(tokenField, {})).toBe(true);
    expect(signsIn(tokenField, { clientId: `  ` })).toBe(true);
    expect(signsIn(tokenField, { clientId: `mine.apps.googleusercontent.com` })).toBe(false);
    expect(signsIn({ key: `refreshToken`, label: `Refresh token`, secret: true }, {})).toBe(false);
});

it(`asks for read only when the card says so`, () => {
    expect(accessOf({ access: `read` })).toBe(`read`);
    expect(accessOf({ access: `write` })).toBe(`write`);
    expect(accessOf({})).toBe(`write`);
});

it(`makes an RFC 7636 verifier and its S256 challenge`, async () => {
    const verifier = makeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(makeVerifier()).not.toBe(verifier);
    // The RFC's own appendix B example.
    expect(await challengeOf(`dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`)).toBe(`E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`);
    expect(await challengeOf(verifier)).toBe(createHash(`sha256`).update(verifier).digest(`base64url`));
    expect(makeState()).toMatch(/^[A-Za-z0-9_-]{32}$/u);
});

it(`acts only on this form's answer, a code or Google's error`, () => {
    const told = (data: unknown) => GoogleCallbackSchema.parse(data);
    expect(readCallback(told({ state: `s1`, code: `c1` }), `s1`)).toEqual({ code: `c1` });
    expect(readCallback(told({ state: `s1`, error: `access_denied` }), `s1`)).toEqual({ error: `access_denied` });
    expect(readCallback(told({ state: `s1` }), `s1`)).toEqual({ error: `no_code` });
    expect(readCallback(told({ state: `other`, code: `c1` }), `s1`)).toBeUndefined();
    expect(GoogleCallbackSchema.safeParse({ code: `c1` }).success).toBe(false);
});

it(`reads what Google granted, not what was asked`, () => {
    const api = `https://www.googleapis.com/auth/`;
    expect(grantedAccess([`openid`, `email`, `${api}gmail.modify`, `${api}calendar.readonly`])).toBe(`write`);
    expect(grantedAccess([`openid`, `${api}gmail.readonly`, `${api}drive.readonly`])).toBe(`read`);
    expect(grantedAccess([`openid`, `email`])).toBe(`read`);
    expect(grantCovers(`read`, `write`)).toBe(false);
    expect(grantCovers(`read`, `read`)).toBe(true);
    expect(grantCovers(`write`, `read`)).toBe(true);
});
