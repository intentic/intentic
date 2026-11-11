import { oc } from "@orpc/contract";
import { z } from "zod";

/* CONNECT GOOGLE: the platform's own OAuth client behind the Google Workspace card's sign-in button, so nobody has to
 * make a Cloud project or paste a refresh token. The editor runs the popup and holds the PKCE verifier; the platform
 * holds the client secret and nothing else, so it builds the consent URL, trades the code once, and forgets the
 * answer. The refresh token is the editor's to put on the card, and later sandbox access tokens are minted through
 * the `googleAccessToken` ingress route, since a refresh needs the secret too. */

export const GoogleAccessSchema = z.enum([`read`, `write`]);

// RFC 7636: a verifier is 43-128 unreserved characters; its S256 challenge is 43 base64url characters.
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;

export const GoogleConnectBeginSchema = z.object({
    access: GoogleAccessSchema,
    // Preselects the account on Google's chooser; the consent may still pick another, and the answer says which.
    loginHint: z.string().max(320).optional(),
    // The editor's own one-time value, checked by the editor when the popup answers; the platform only carries it.
    state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
    codeChallenge: z.string().regex(PKCE_CHALLENGE),
});

export const GoogleConnectUrlSchema = z.object({
    url: z.url(),
});

export const GoogleConnectFinishSchema = z.object({
    code: z.string().min(1).max(2048),
    codeVerifier: z.string().regex(PKCE_VERIFIER),
});

export const GoogleConnectGrantSchema = z.object({
    refreshToken: z.string().min(1),
    // The address the consent was given as, read off the token answer's ID token.
    email: z.string(),
    // What Google actually granted: a person can untick a scope on the consent screen.
    scopes: z.array(z.string()),
});
export type GoogleConnectGrant = z.infer<typeof GoogleConnectGrantSchema>;

export const googleConnectContract = {
    // 404 on a platform with no Google client configured: the card then offers the owner's own client instead.
    begin: oc.route({ method: `POST`, path: `/google-connect/begin` }).input(GoogleConnectBeginSchema).output(GoogleConnectUrlSchema),
    finish: oc.route({ method: `POST`, path: `/google-connect/finish` }).input(GoogleConnectFinishSchema).output(GoogleConnectGrantSchema),
};

// Where Google sends the popup back: a static page on the editor's origin that hands the code to the window that
// opened it. Registered as an authorized redirect URI on the platform's Google client.
export const GOOGLE_CONNECT_CALLBACK_PATH = `/oauth/google.html`;
// The message that page broadcasts, on a BroadcastChannel of this name and to its opener.
export const GOOGLE_CONNECT_CHANNEL = `intentic:google-connect`;
