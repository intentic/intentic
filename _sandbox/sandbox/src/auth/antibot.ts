import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { PowChallenge, WebchatConfig, WebchatMessage } from "@intentic/sandbox-contract";

// The bot ceiling for an anonymous endpoint (two flavours), shared by the Front Desk widget and the bug intake: both
// face a browser with no credential.
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

// The widget sends `<salt>:<nonce>`; the daemon re-derives the salt's HMAC rather than storing it, so verifying is one
// HMAC and one hash.
const verifyProofOfWork = (answer: string, conversationId: string, now: number): boolean => {
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

// Cloudflare's server-side half. The secret never leaves the daemon, the widget only ever holds the site key.
const verifyTurnstile = async (secretKey: string, token: string, remoteIp: string | undefined): Promise<boolean> => {
    const body = new URLSearchParams({ secret: secretKey, response: token, ...(remoteIp !== undefined ? { remoteip: remoteIp } : {}) });
    const response = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body });
    if (!response.ok) {
        return false;
    }
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
};

// Whichever answer the widget sent, the contract's own fields, so the two can't drift apart.
export type AntiBotAnswer = Pick<WebchatMessage, "turnstileToken" | "powNonce">;

// Whether this message clears the configured gate.
// `kind` is the enforced mechanism (webchat-config's usableAntiBot), not the raw stored setting, so a half-configured
// check can't silently vanish or become impossible.
export const antiBotAccepted = async (
    kind: "turnstile" | "pow" | "off",
    config: WebchatConfig,
    answer: AntiBotAnswer,
    conversationId: string,
    remoteIp: string | undefined,
    now: number,
): Promise<boolean> => {
    if (kind === "off") {
        return true;
    }
    if (kind === "pow") {
        return answer.powNonce !== undefined && verifyProofOfWork(answer.powNonce, conversationId, now);
    }
    return answer.turnstileToken !== undefined && config.turnstileSecret !== undefined
        ? verifyTurnstile(config.turnstileSecret, answer.turnstileToken, remoteIp)
        : false;
};
