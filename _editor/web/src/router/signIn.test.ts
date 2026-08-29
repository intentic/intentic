// WHERE A SIGN-IN GOES, AND WHERE IT COMES BACK TO. Two lines of code, tested, for the reason setupGate.ts is:
// this is one decision taken on behalf of every guarded route in the app, and it fails invisibly — the user IS
// signed in afterwards, just not on the page they were going to.
import { expect, it } from "vitest";
import { returnPath, signInAt } from "./signIn";

it(`carries the page that asked for the sign-in`, () => {
    expect(signInAt(`/sandbox/usage`)).toEqual({ path: `/login`, query: { returnTo: `/sandbox/usage` } });
});

/* THE ONE THAT BROKE A PRODUCT. The desktop app opens this URL in the OS default browser, which is routinely a
 * window nobody has signed in; the query is what ties the sign-in to the app waiting on a deep link. Dropping
 * it left the browser in a signed-in workspace and the app on its own sign-in screen. (That page resolves its
 * own session now and never comes through here — this is the guarantee that no future guard can re-break it.) */
it(`keeps a desktop hand-off's state and challenge`, () => {
    const at = signInAt(`/desktop-auth?state=nonce&challenge=chal`);

    expect(at).toEqual({ path: `/login`, query: { returnTo: `/desktop-auth?state=nonce&challenge=chal` } });
});

// Nothing to carry: `returnTo=/` is where this screen goes anyway, and a login page pointing at itself is a
// loop waiting for the day something reads it back.
it(`says nothing when there is nothing to say`, () => {
    expect(signInAt(`/`)).toBe(`/login`);
    expect(signInAt(`/login`)).toBe(`/login`);
});

it(`reads a rooted path straight back`, () => {
    expect(returnPath(`/sandbox/usage?tab=accounts`)).toBe(`/sandbox/usage?tab=accounts`);
});

/* AN OPEN REDIRECT ON THE ONE PAGE A USER HAS BEEN TAUGHT TO EXPECT GOOGLE ON. The value is spent as a router
 * navigation AND as `origin + this` for an OAuth callback, and both `//host` and `/\host` are protocol-relative
 * URLs to a parser. Anything that is not a plain rooted path is the workspace. */
it(`refuses anything that could leave this origin`, () => {
    expect(returnPath(`//evil.example`)).toBe(`/`);
    expect(returnPath(`/\\evil.example`)).toBe(`/`);
    expect(returnPath(`https://evil.example`)).toBe(`/`);
    expect(returnPath(`javascript:alert(1)`)).toBe(`/`);
});

// A query parameter is whatever the address bar says it is: absent, repeated (an array), or empty.
it(`treats a missing or malformed parameter as no destination`, () => {
    expect(returnPath(undefined)).toBe(`/`);
    expect(returnPath([`/a`, `/b`])).toBe(`/`);
    expect(returnPath(``)).toBe(`/`);
});
