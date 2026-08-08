import { expect, test } from "vitest";
import { idTokenClaims } from "./googleToken";

const segment = (value: unknown): string => btoa(JSON.stringify(value)).replace(/=/g, ``).replace(/\+/g, `-`).replace(/\//g, `_`);
const jwt = (payload: unknown): string => `${segment({ alg: `RS256` })}.${segment(payload)}.signature`;

test("only accepts a JWT-shaped Google credential with a real expiry and email", () => {
    expect(idTokenClaims(jwt({ exp: 2_000_000_000, email: `owner@example.com` }))).toEqual({
        expiresAt: 2_000_000_000_000,
        email: `owner@example.com`,
    });
    expect(idTokenClaims(`not-a-jwt`)).toBeUndefined();
    expect(idTokenClaims(jwt({ email: `owner@example.com` }))).toBeUndefined();
    expect(idTokenClaims(jwt({ exp: 2_000_000_000 }))).toBeUndefined();
    expect(idTokenClaims(`a.${segment({ exp: 2_000_000_000, email: `owner@example.com` })}.`)).toBeUndefined();
});
