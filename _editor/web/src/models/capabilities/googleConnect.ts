import type { CapabilityField } from "@intentic/extension-manifest";
import { z } from "zod";
import type { FormValues } from "./form";

// Connect Google, as the form drives it: the platform's own OAuth client runs the consent in a popup, and the code
// comes back to the editor's origin (public/oauth/google.html), which hands it to the form that opened it. The form holds
// the PKCE verifier, so a code read by anyone else is worth nothing; the platform trades it and the refresh token
// lands in the card's field, for the ordinary Save to store.

export type GoogleAccess = `read` | `write`;

// The field the sign-in stands in for, while the card uses the platform's client. A client ID of the owner's own
// (under Advanced) means a token made on that client, which only a paste can supply, so the plain box comes back.
export const signsIn = (field: CapabilityField, values: Readonly<FormValues>): boolean =>
    field.signIn === `google` && (values[`clientId`] ?? ``).trim() === ``;

// The card's read-only switch, as the consent asks for it: anything but `read` is the card's default, read & write.
export const accessOf = (values: Readonly<FormValues>): GoogleAccess => (values[`access`] === `read` ? `read` : `write`);

const base64url = (bytes: Uint8Array): string =>
    btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(``))
        .replaceAll(`+`, `-`)
        .replaceAll(`/`, `_`)
        .replace(/=+$/u, ``);

const randomUrlSafe = (length: number): string => base64url(crypto.getRandomValues(new Uint8Array(length)));

// RFC 7636: 32 random bytes make a 43-character verifier; its S256 challenge is the base64url SHA-256 of it.
export const makeVerifier = (): string => randomUrlSafe(32);
export const challengeOf = async (verifier: string): Promise<string> =>
    base64url(new Uint8Array(await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(verifier))));
// The one-time value the popup's answer must carry back to be this form's.
export const makeState = (): string => randomUrlSafe(24);

// What the callback page posts, parsed where a message arrives (a BroadcastChannel or a window message).
export const GoogleCallbackSchema = z.object({ state: z.string(), code: z.string().optional(), error: z.string().optional() });
export type GoogleCallback = z.infer<typeof GoogleCallbackSchema>;

export type CallbackAnswer = { readonly code: string } | { readonly error: string };

// What the callback page said, when it answers this form's consent: another tab's consent is not this form's to act on.
export const readCallback = (message: GoogleCallback, expectedState: string): CallbackAnswer | undefined => {
    if (message.state !== expectedState) {
        return undefined;
    }
    if (message.code !== undefined && message.code !== ``) {
        return { code: message.code };
    }
    return { error: message.error ?? `no_code` };
};

const GOOGLE_API_SCOPE = `https://www.googleapis.com/auth/`;

// What a grant lets the agent do: a person can untick scopes on Google's consent screen, so the granted list, not the
// one asked for, is the answer. Any API scope without `.readonly` makes it read & write.
export const grantedAccess = (scopes: readonly string[]): GoogleAccess =>
    scopes.some((scope) => scope.startsWith(GOOGLE_API_SCOPE) && !scope.endsWith(`.readonly`)) ? `write` : `read`;

// Whether a grant covers what the card now asks for: a read-only grant does not cover read & write.
export const grantCovers = (granted: GoogleAccess, wanted: GoogleAccess): boolean => granted === `write` || wanted === `read`;
