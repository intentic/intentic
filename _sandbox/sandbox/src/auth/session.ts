import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { jwtVerify, SignJWT } from "jose";
import type { VerifiedIdentity } from "./auth.js";

// Daemon-minted HMAC session: the steady-state browser credential once a Google ID token verifies identity.
// Owner/member enforcement stays per-request in auth.ts, so a live session cannot outlive a revoked grant.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Pins the issuer so no other JWT sharing this secret can pass as a session, and vice versa.
const ISSUER = "intentic-sandbox-session";

export interface MintedSession {
    readonly token: string;
    // Epoch ms; lets the browser renew ahead of expiry without parsing the token.
    readonly expiresAt: number;
}

export interface Sessions {
    mint(identity: VerifiedIdentity): Promise<MintedSession>;
    // Returns the identity a valid session was minted for; throws on signature/claim failure.
    verify(token: string): Promise<VerifiedIdentity>;
    // Re-keys the signing secret: every previously minted session, owner and members alike, stops verifying at once.
    // There is no per-session revoke, only this full sign-out-everywhere.
    rotate(): Promise<void>;
}

export const createSessions = (secretPath: string): Sessions => {
    // Secret file is 0600 and persisted across restarts; cached as a promise so concurrent loads share one create.
    let secret: Promise<Uint8Array> | undefined;
    const writeFresh = async (): Promise<Uint8Array> => {
        const fresh = randomBytes(32);
        await mkdir(dirname(secretPath), { recursive: true });
        await writeFile(secretPath, fresh.toString("base64url"), { mode: 0o600 });
        return fresh;
    };
    const loadSecret = (): Promise<Uint8Array> => {
        secret ??= (async () => {
            const stored = await readFile(secretPath, "utf8").catch(() => undefined);
            if (stored !== undefined) {
                const bytes = Buffer.from(stored.trim(), "base64url");
                // A truncated or corrupt file must not become a weak HMAC key; fall through and re-key.
                if (bytes.length >= 32) {
                    return bytes;
                }
            }
            return writeFresh();
        })();
        return secret;
    };
    return {
        mint: async (identity) => {
            const expiresAt = Date.now() + SESSION_TTL_MS;
            const token = await new SignJWT({
                ...(identity.name !== undefined ? { name: identity.name } : {}),
                ...(identity.picture !== undefined ? { picture: identity.picture } : {}),
            })
                .setProtectedHeader({ alg: "HS256" })
                .setSubject(identity.email)
                .setIssuer(ISSUER)
                .setIssuedAt()
                .setExpirationTime(Math.floor(expiresAt / 1000))
                .sign(await loadSecret());
            return { token, expiresAt };
        },
        verify: async (token) => {
            // 60s clockTolerance, matching the Google verifier, so a fast container clock doesn't reject a fresh token.
            const { payload } = await jwtVerify(token, await loadSecret(), { issuer: ISSUER, algorithms: ["HS256"], clockTolerance: 60 });
            if (typeof payload.sub !== "string" || payload.sub === "") {
                throw new Error("session token has no subject");
            }
            return {
                email: payload.sub,
                ...(typeof payload["name"] === "string" ? { name: payload["name"] } : {}),
                ...(typeof payload["picture"] === "string" ? { picture: payload["picture"] } : {}),
            };
        },
        // Cache is replaced before awaiting the write, so a verify racing rotation uses the new secret, not the
        // retiring one.
        rotate: async () => {
            secret = writeFresh();
            await secret;
        },
    };
};
