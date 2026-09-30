import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { GOOGLE_CLIENT_ID } from "@intentic/constants";
import type { BrowserContext } from "@playwright/test";

// Google, stood in for at the two places the sign-in meets it, and nowhere else:
//
// - In the browser, Google Identity Services (the `gsi/client` script) is the only thing that hands the page a
//   credential. This serves a script with the slice of its API useGoogleIdentity.ts calls, whose button answers with
//   an ID token for the person the spec chose.
// - On the api, Better Auth's one-tap verifies that token against Google's JWKS. The tier's api (_platform/api
//   src/e2e/browser-api.ts) answers Google's certs address with the public half of the key that signed it.
//
// So the token is a real RS256 JWT with Google's issuer, the web client's audience and a fresh `iat`, and the
// verification that accepts it is the production code's own. What this cannot prove is that Google still accepts this
// origin for the client; the post-deploy smoke (smoke-signin.mjs) is the check against Google's real origin check.

const GOOGLE_KID = `intentic-signin-e2e`;
const GIS_SCRIPT = `https://accounts.google.com/gsi/client`;

export interface Person {
    readonly email: string;
    readonly name: string;
    // Google's stable subject, the account id Better Auth links on.
    readonly sub: string;
}

// A fresh person per spec, so no spec leans on another's account or session.
export const newPerson = (label: string): Person => {
    const id = randomUUID().slice(0, 8);
    return { email: `${label}-${id}@signin.e2e.intentic.dev`, name: `Sign-in ${label}`, sub: `e2e-${label}-${id}` };
};

export const newGoogleKey = (): { readonly privatePem: string; readonly jwks: { readonly keys: readonly object[] } } => {
    const { privateKey, publicKey } = generateKeyPairSync(`rsa`, { modulusLength: 2048 });
    return {
        privatePem: privateKey.export({ type: `pkcs8`, format: `pem` }).toString(),
        jwks: { keys: [{ ...publicKey.export({ format: `jwk` }), kid: GOOGLE_KID, alg: `RS256`, use: `sig` }] },
    };
};

const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString(`base64url`);

// An ID token as Google mints one for the web client: the claims Better Auth's verifyGoogleIdToken checks (issuer,
// audience, signature, expiry, token age) and the ones one-tap reads (sub, email, email_verified, name).
const idTokenFor = (person: Person, privatePem: string): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url({ alg: `RS256`, kid: GOOGLE_KID, typ: `JWT` });
    const payload = base64url({
        iss: `https://accounts.google.com`,
        azp: GOOGLE_CLIENT_ID,
        aud: GOOGLE_CLIENT_ID,
        sub: person.sub,
        email: person.email,
        email_verified: true,
        name: person.name,
        iat: now,
        exp: now + 60 * 60,
    });
    const signature = sign(`RSA-SHA256`, Buffer.from(`${header}.${payload}`), createPrivateKey(privatePem)).toString(`base64url`);
    return `${header}.${payload}.${signature}`;
};

// The label the fake button carries, so a spec presses Google's button and not the page's own fallback.
export const GOOGLE_BUTTON = `Sign in with the e2e Google account`;

// The slice of `google.accounts.id` useGoogleIdentity.ts calls. `prompt` reports a skipped moment, the answer a
// first-time visitor gets, so the credential only ever arrives through the rendered button: the press is part of what
// each spec proves, and a spec that expects no press (a silent road) proves that too.
const fakeGis = (credential: string): string => `(() => {
    const credential = ${JSON.stringify(credential)};
    let config;
    window.google = { accounts: { id: {
        initialize(next) { config = next; },
        renderButton(parent) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = ${JSON.stringify(GOOGLE_BUTTON)};
            button.addEventListener("click", () => config?.callback({ credential, select_by: "btn" }));
            parent.replaceChildren(button);
        },
        prompt(listener) {
            setTimeout(() => listener?.({ isSkippedMoment: () => true, isDismissedMoment: () => false, getDismissedReason: () => "" }), 0);
        },
        cancel() {},
        disableAutoSelect() {},
    } } };
})();`;

/**
 * Makes `person` the Google account this browser context is signed in to. Everything else addressed to Google is
 * refused, so a page that reached for the real Google (its OAuth redirect, its fonts, its FedCM endpoints) fails the
 * spec rather than passing on a network the tier never meant to use.
 */
export const signInToGoogle = async (context: BrowserContext, person: Person, privatePem: string): Promise<void> => {
    const credential = idTokenFor(person, privatePem);
    await context.route(/^https:\/\/([a-z0-9-]+\.)*(google\.com|googleapis\.com|gstatic\.com)\//u, (route) =>
        route.request().url().startsWith(GIS_SCRIPT)
            ? route.fulfill({ status: 200, contentType: `text/javascript`, body: fakeGis(credential) })
            : route.abort(`blockedbyclient`),
    );
};
