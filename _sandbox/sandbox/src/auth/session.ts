import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ProofMethodSchema } from "@intentic/sandbox-contract";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import type { Proof } from "./auth.js";

// Daemon-minted HMAC session: the steady-state browser credential once a Google ID token or a passkey verifies identity.
// Owner/member enforcement stays per-request in auth.ts, so a live session cannot outlive a revoked grant; the session
// carries HOW it was proven (`amr`) so the require-passkey policy is re-read per request too.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Pins the issuer so no other JWT sharing this secret can pass as a session, and vice versa.
const ISSUER = "intentic-sandbox-session";

export interface MintedSession {
    readonly token: string;
    // Epoch ms; lets the browser renew ahead of expiry without parsing the token.
    readonly expiresAt: number;
}

// The proof claims a session carries: the methods that established it, and the passkey it came from when one did.
const ProofClaimsSchema = z.object({ amr: z.array(ProofMethodSchema).min(1), cid: z.string().optional() });

export interface Sessions {
    mint(proof: Proof): Promise<MintedSession>;
    // Returns the proof a valid session was minted for; throws on signature/claim failure.
    verify(token: string): Promise<Proof>;
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
        mint: async (proof) => {
            const expiresAt = Date.now() + SESSION_TTL_MS;
            const token = await new SignJWT({
                ...(proof.name !== undefined ? { name: proof.name } : {}),
                ...(proof.picture !== undefined ? { picture: proof.picture } : {}),
                amr: [...proof.methods],
                ...(proof.credentialId !== undefined ? { cid: proof.credentialId } : {}),
            })
                .setProtectedHeader({ alg: "HS256" })
                .setSubject(proof.email)
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
            // A session without `amr` predates the claim; refusing it costs one silent re-sign-in, accepting it would
            // let the require-passkey policy be met by a token minted before the policy could ask.
            const claims = ProofClaimsSchema.safeParse(payload);
            if (!claims.success) {
                throw new Error("session token carries no proof claims");
            }
            return {
                email: payload.sub,
                ...(typeof payload["name"] === "string" ? { name: payload["name"] } : {}),
                ...(typeof payload["picture"] === "string" ? { picture: payload["picture"] } : {}),
                methods: claims.data.amr,
                ...(claims.data.cid !== undefined ? { credentialId: claims.data.cid } : {}),
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
