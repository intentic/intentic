import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { jwtVerify, SignJWT } from "jose";
import type { VerifiedIdentity } from "./auth.js";

/* Daemon-minted sessions: the steady-state browser credential. A Google ID token proves WHO a caller is
 * (auth.ts verifies it against Google's JWKS), but it lives about an hour and renewing it needs Google UI in
 * the browser — which is how "Sign in with Google" kept popping over a perfectly healthy workspace. So after
 * any Google-verified request the daemon mints its own HMAC-signed session (system.session), and every later
 * call presents that instead: Google becomes the sign-in moment, not an hourly tax. The security shape is
 * unchanged — the secret never leaves the sandbox, the platform still holds nothing it could replay, and
 * owner/member enforcement stays per-request in auth.ts, so a live session does not outlive a revoked grant. */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Issuer pin so no other JWT that happens to share the secret's alg can pass as a session (and vice versa).
const ISSUER = "intentic-sandbox-session";

export interface MintedSession {
    readonly token: string;
    // Epoch ms — echoed to the browser so it can renew ahead of expiry without parsing the token.
    readonly expiresAt: number;
}

export interface Sessions {
    mint(identity: VerifiedIdentity): Promise<MintedSession>;
    // Returns the identity a valid session was minted for; throws on any signature/claim failure.
    verify(token: string): Promise<VerifiedIdentity>;
}

export const createSessions = (secretPath: string): Sessions => {
    // One secret per sandbox, created 0600 on first use (no provisioning step) and persisted so sessions
    // survive daemon restarts — a rebuild must not re-prompt every browser. Cached as the promise so
    // concurrent first requests share one load/create instead of racing to write two secrets.
    let secret: Promise<Uint8Array> | undefined;
    const loadSecret = (): Promise<Uint8Array> => {
        secret ??= (async () => {
            const stored = await readFile(secretPath, "utf8").catch(() => undefined);
            if (stored !== undefined) {
                const bytes = Buffer.from(stored.trim(), "base64url");
                // A truncated/corrupt file must not become a weak HMAC key — fall through and re-key.
                if (bytes.length >= 32) {
                    return bytes;
                }
            }
            const fresh = randomBytes(32);
            await mkdir(dirname(secretPath), { recursive: true });
            await writeFile(secretPath, fresh.toString("base64url"), { mode: 0o600 });
            return fresh;
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
            // Same 60s clockTolerance as the Google verifier: a container clock ahead of the browser's must
            // not read a just-minted token as not-yet-valid.
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
    };
};
