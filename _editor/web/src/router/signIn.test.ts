// Where a sign-in goes, and where it comes back to: one decision on behalf of every guarded route.
// Fails invisibly if wrong — the user ends up signed in, just not on the page they wanted.
import { expect, it } from "vitest";
import { returnPath, signInAt } from "./signIn";

it(`carries the page that asked for the sign-in`, () => {
    expect(signInAt(`/sandbox/usage`)).toEqual({ path: `/login`, query: { returnTo: `/sandbox/usage` } });
});

// The desktop app opens this URL in the OS browser, which may not be signed in; state and challenge tie
// the sign-in back to the app's deep link, so they must survive returnTo untouched.
it(`keeps a desktop hand-off's state and challenge`, () => {
    const at = signInAt(`/desktop-auth?state=nonce&challenge=chal`);

    expect(at).toEqual({ path: `/login`, query: { returnTo: `/desktop-auth?state=nonce&challenge=chal` } });
});

// `/` and `/login` need no returnTo: pointing the login page at itself would loop.
it(`says nothing when there is nothing to say`, () => {
    expect(signInAt(`/`)).toBe(`/login`);
    expect(signInAt(`/login`)).toBe(`/login`);
});

it(`reads a rooted path straight back`, () => {
    expect(returnPath(`/sandbox/usage?tab=accounts`)).toBe(`/sandbox/usage?tab=accounts`);
});

// The value doubles as a router path and as `origin + this` for an OAuth callback, so `//host` and
// `/\\host` (protocol-relative to a parser) must be refused, along with anything not a plain rooted path.
it(`refuses anything that could leave this origin`, () => {
    expect(returnPath(`//evil.example`)).toBe(`/`);
    expect(returnPath(`/\\evil.example`)).toBe(`/`);
    expect(returnPath(`https://evil.example`)).toBe(`/`);
    expect(returnPath(`javascript:alert(1)`)).toBe(`/`);
});

// A query param can arrive absent, repeated (array), or empty; all are malformed.
it(`treats a missing or malformed parameter as no destination`, () => {
    expect(returnPath(undefined)).toBe(`/`);
    expect(returnPath([`/a`, `/b`])).toBe(`/`);
    expect(returnPath(``)).toBe(`/`);
});
