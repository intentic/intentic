import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { PowChallenge } from "@intentic/sandbox-contract/schemas/automations";

// The bot ceiling for an anonymous endpoint (two flavours), checked by an extension's public doors for a route that asks
// for one (extensions/backend/public-door.routes.ts): the Visitor chat's widget and the bug reporter, each a browser with
// no credential, call through them since 2026-11-26.
// A ceiling, not a wall: neither stops a determined human, the automation's tool allowlist and budget caps bound the
// damage if one gets through.
// What it buys: a scraper doesn't get to spend an agent turn per request.

// A challenge is spent on a thread's first message; the window only needs to cover open-then-type.
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

// Enough work to make a bot request uneconomic, little enough for a phone (~65k SHA-256s at 16 bits).
const POW_DIFFICULTY = 16;

// Per-boot secret: the salt self-verifies via HMAC, so nothing is stored per outstanding challenge.
const secret = randomBytes(32);

const sign = (issuedAt: number, nonce: string, conversationId: string): string =>
    createHmac("sha256", secret).update(`${issuedAt}.${nonce}.${conversationId}`).digest("hex");

export const mintChallenge = (conversationId: string, now: number): PowChallenge => {
    const issuedAt = now;
    const nonce = randomBytes(9).toString("base64url");
    return { salt: `${issuedAt}.${nonce}.${sign(issuedAt, nonce, conversationId)}`, difficulty: POW_DIFFICULTY };
};

const saltValid = (salt: string, conversationId: string, now: number): boolean => {
    const [issuedAtText, nonce, mac] = salt.split(".");
    if (issuedAtText === undefined || nonce === undefined || mac === undefined) {
        return false;
    }
    const issuedAt = Number(issuedAtText);
    if (!Number.isFinite(issuedAt) || now - issuedAt > CHALLENGE_TTL_MS || issuedAt > now + 60_000) {
        return false;
    }
    const expected = Buffer.from(sign(issuedAt, nonce, conversationId), "utf8");
    const actual = Buffer.from(mac, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const leadingZeroBits = (digest: Buffer): number => {
    let bits = 0;
    for (const byte of digest) {
        if (byte !== 0) {
            return bits + Math.clz32(byte) - 24;
        }
        bits += 8;
    }
    return bits;
};

// The caller sends `<salt>:<nonce>`; the daemon re-derives the salt's HMAC rather than storing it, so verifying is one
// HMAC and one hash. `caller` is the id the challenge was minted for, so a solution cannot move to another.
export const proofOfWorkSolved = (answer: string, conversationId: string, now: number): boolean => {
    const separator = answer.lastIndexOf(":");
    if (separator <= 0) {
        return false;
    }
    const salt = answer.slice(0, separator);
    const nonce = answer.slice(separator + 1);
    if (!saltValid(salt, conversationId, now)) {
        return false;
    }
    return leadingZeroBits(createHash("sha256").update(`${salt}:${nonce}`).digest()) >= POW_DIFFICULTY;
};

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare's server-side half, for a public door's route declaring `turnstile`: the secret never leaves the daemon,
// the page only ever holds the site key.
export const verifyTurnstile = async (secretKey: string, token: string, remoteIp: string | undefined): Promise<boolean> => {
    const body = new URLSearchParams({ secret: secretKey, response: token, ...(remoteIp !== undefined ? { remoteip: remoteIp } : {}) });
    const response = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body });
    if (!response.ok) {
        return false;
    }
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
};
