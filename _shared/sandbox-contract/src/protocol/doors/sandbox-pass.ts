import { createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import { SANDBOX_ID } from "../../ids/tunnel-ids.js";

// The platform's signed word that one sandbox may report to another ON THE SAME ACCOUNT about one project: the
// credential behind account-level report routing. The sending daemon asks the platform who owns a project
// (`projectResolve`, authenticated by its connect token, so `from` is the platform's own reading, never the sender's
// claim); the platform answers with the owner's address and this pass; the receiving daemon checks it against the
// platform's identity key it already holds (the announce answer's `identityKey`). Signed with the same key as the
// identity assertion, under its own prefix, so neither can ever stand in for the other.

const PASS_PREFIX = "sp1";

// Long enough for an outbox to drain a few reports through one resolve; short enough that a lifted pass is soon dead.
export const SANDBOX_PASS_TTL_MS = 10 * 60_000;
// What a daemon accepts whatever the claim says, so a platform minting with a wrong ttl cannot hand out a long credential.
export const SANDBOX_PASS_MAX_TTL_MS = 15 * 60_000;

// The header a pass rides on the receiving daemon's `/account/` routes.
export const SANDBOX_PASS_HEADER = "x-intentic-sandbox-pass";

export interface SandboxPass {
    // The sending sandbox's tunnel id, and the name its owner gave it (for the inbox; display only).
    readonly from: string;
    readonly fromName: string;
    // The receiving sandbox's tunnel id: a daemon refuses a pass addressed to anyone else.
    readonly to: string;
    // The normalized project id the receiver claims (project-id.ts).
    readonly project: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
}

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

// The prefix is part of what is signed: a pass is never a valid signature over an identity assertion, nor the reverse.
const signedBytes = (payload: Buffer): Buffer => Buffer.concat([Buffer.from(`${PASS_PREFIX}.`, "utf8"), payload]);

export const isSandboxPass = (token: string): boolean => token.startsWith(`${PASS_PREFIX}.`);

export const mintSandboxPass = (
    privateKeyPem: string,
    claim: {
        readonly from: string;
        readonly fromName: string;
        readonly to: string;
        readonly project: string;
        readonly issuedAtMs: number;
        readonly ttlMs?: number;
    },
): string => {
    if (!SANDBOX_ID.test(claim.from) || !SANDBOX_ID.test(claim.to)) {
        throw new Error("a sandbox pass names two 12-hex sandbox ids");
    }
    if (claim.from === claim.to) {
        throw new Error("a sandbox pass is from one sandbox to another");
    }
    if (claim.project.trim() === "") {
        throw new Error("a sandbox pass names a project");
    }
    const ttlMs = claim.ttlMs ?? SANDBOX_PASS_TTL_MS;
    if (ttlMs <= 0 || ttlMs > SANDBOX_PASS_MAX_TTL_MS) {
        throw new Error(`a sandbox pass lives at most ${SANDBOX_PASS_MAX_TTL_MS} ms`);
    }
    const payload = Buffer.from(
        JSON.stringify({
            v: 1,
            iss: claim.from,
            name: claim.fromName.slice(0, 120),
            aud: claim.to,
            prj: claim.project,
            iat: Math.floor(claim.issuedAtMs / 1000),
            exp: Math.floor((claim.issuedAtMs + ttlMs) / 1000),
            jti: base64url(randomBytes(12)),
        }),
        "utf8",
    );
    const signature = edSign(null, signedBytes(payload), createPrivateKey(privateKeyPem));
    return `${PASS_PREFIX}.${base64url(payload)}.${base64url(signature)}`;
};

const PassPayloadSchema = z.object({
    v: z.literal(1),
    iss: z.string().regex(SANDBOX_ID),
    name: z.string(),
    aud: z.string().regex(SANDBOX_ID),
    prj: z.string().min(1),
    iat: z.number(),
    exp: z.number(),
    jti: z.string().min(1),
});

// Verifies a pass against the platform's public key at nowMs; undefined for any way of being invalid (wrong prefix, bad
// signature, malformed claim, expired, issued in the future, living longer than allowed). The caller checks `to`
// against its own id and `project` against its own claims.
export const verifySandboxPass = (publicKeyPem: string, token: string, nowMs: number): SandboxPass | undefined => {
    const [prefix, encodedPayload, encodedSignature, ...rest] = token.split(".");
    if (prefix !== PASS_PREFIX || encodedPayload === undefined || encodedSignature === undefined || rest.length > 0) {
        return undefined;
    }
    const payload = Buffer.from(encodedPayload, "base64url");
    try {
        if (!edVerify(null, signedBytes(payload), createPublicKey(publicKeyPem), Buffer.from(encodedSignature, "base64url"))) {
            return undefined;
        }
    } catch {
        // allow(silent-catch): a key or signature that does not parse verifies nothing: the pass is invalid, said as undefined.
        return undefined;
    }
    const claim = parseJsonWith(payload.toString("utf8"), PassPayloadSchema);
    if (claim === undefined || claim.iss === claim.aud) {
        return undefined;
    }
    if (claim.exp * 1000 <= nowMs || claim.iat * 1000 > nowMs + 60_000 || (claim.exp - claim.iat) * 1000 > SANDBOX_PASS_MAX_TTL_MS) {
        return undefined;
    }
    return { from: claim.iss, fromName: claim.name, to: claim.aud, project: claim.prj, issuedAt: claim.iat, expiresAt: claim.exp };
};
