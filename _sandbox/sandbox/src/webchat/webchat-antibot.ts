import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { WebchatChallenge, WebchatConfig, WebchatMessage } from "@intentic/sandbox-contract";

/* The bot ceiling for a public endpoint, in the two flavours webchat-config offers — and the reason it is a
 * ceiling rather than a wall: neither of these stops a determined human, and the automation's tool allowlist
 * and budget caps are what bound the damage if one gets through. What these buy is that a scraper pointed at
 * a Front Desk does not get to spend an agent turn per request. */

// A challenge is spent on the FIRST message of a visitor thread (an existing session record is the admission
// mark), so this window only has to cover "opened the panel, then typed".
const CHALLENGE_TTL_MS = 15 * 60 * 1000;

/* Enough work to make a per-request bot uneconomic, little enough that a phone spends about a second on it.
 * 16 bits ⇒ ~65k SHA-256s expected; the widget solves it in yielding batches so the page keeps painting. */
const POW_DIFFICULTY = 16;

/* The salt is SELF-VERIFYING: `<issuedAt>.<nonce>.<hmac>` over the daemon's per-boot secret and the
 * conversation it was minted for. That binding is the whole design — it means the daemon stores nothing
 * per outstanding challenge (no table to grow, no cleanup to get wrong), a solution can't be moved to another
 * visitor's thread, and a restart simply invalidates every challenge in flight rather than admitting them all.
 * Per-boot, because a challenge outliving a restart buys nothing: the visitor just solves another. */
const secret = randomBytes(32);

const sign = (issuedAt: number, nonce: string, conversationId: string): string =>
    createHmac("sha256", secret).update(`${issuedAt}.${nonce}.${conversationId}`).digest("hex");

export const issueChallenge = (conversationId: string, now: number): WebchatChallenge => {
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

/* The widget sends back `<salt>:<nonce>` — the salt so the daemon can re-derive what it issued without having
 * kept it, the nonce as the answer. Verifying is one HMAC and one hash. */
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

// Cloudflare's server-side half. The secret never leaves the daemon — the widget only ever holds the site key.
const verifyTurnstile = async (secretKey: string, token: string, remoteIp: string | undefined): Promise<boolean> => {
    const body = new URLSearchParams({ secret: secretKey, response: token, ...(remoteIp !== undefined ? { remoteip: remoteIp } : {}) });
    const response = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body });
    if (!response.ok) {
        return false;
    }
    const result = (await response.json()) as { success?: unknown };
    return result.success === true;
};

// Whichever answer the widget sent — the contract's own fields, so the two can't drift apart.
export type AntiBotAnswer = Pick<WebchatMessage, "turnstileToken" | "powNonce">;

/* Whether this message clears the configured gate. `kind` is the ENFORCED mechanism (webchat-config's
 * usableAntiBot), never the raw stored setting — so a half-configured check can't become a gate nobody can
 * pass, and can't become a gate that silently isn't there either. */
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
