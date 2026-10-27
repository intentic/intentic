// THE DESKTOP APP'S SIGN-IN HAND-OFFS: a browser that just signed in parks its session (and its Google ID token, for an
// account that has one) under a row id, and the app's webview redeems that row once with the PKCE verifier only it
// holds. Kept as the platform keeps them (desktop.routes.ts): three minutes to live, spent on the first redeem, and a
// wrong verifier never consumes the real pending row.

const HANDOFF_TTL_MS = 3 * 60_000;

interface Parked {
    readonly challenge: string;
    readonly idToken?: string;
    readonly expiresAt: number;
}

const parked = new Map<string, Parked>();

const base64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, `-`).replace(/\//g, `_`).replace(/=+$/, ``);

// S256, as the app derives the challenge from its verifier.
const challengeOf = async (verifier: string): Promise<string> => base64Url(new Uint8Array(await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(verifier))));

/** desktop.handoff: the row the app's deep link will carry, never the credentials themselves. */
export const parkHandoff = (challenge: string, idToken: string | undefined): string => {
    const id = crypto.randomUUID();
    parked.set(id, idToken === undefined ? { challenge, expiresAt: Date.now() + HANDOFF_TTL_MS } : { challenge, idToken, expiresAt: Date.now() + HANDOFF_TTL_MS });
    return id;
};

/** desktop.redeem: the one-time token (and Google's), once; undefined for a row unknown, expired, spent or not this verifier's. */
export const redeemHandoff = async (handoff: string, verifier: string): Promise<{ ott: string; idToken?: string } | undefined> => {
    const row = parked.get(handoff);
    if (row === undefined || row.expiresAt < Date.now() || row.challenge !== (await challengeOf(verifier))) {
        return undefined;
    }
    parked.delete(handoff);
    const ott = `demo-ott-${crypto.randomUUID()}`;
    return row.idToken === undefined ? { ott } : { ott, idToken: row.idToken };
};
