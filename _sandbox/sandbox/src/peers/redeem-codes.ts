import { randomInt } from "node:crypto";
import { SHORT_CODE_ALPHABET, zoneFromUrl } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { remoteIpOf } from "../automations/public-door.js";
import type { SyncMode } from "./desktop-sync.js";

// SHORT CODES: what a copy-paste command carries instead of a token. The sandbox mints one beside each device, sync or
// server-connect token it hands out, and the install script redeems it here, at POST /system/redeem/<code>, for the
// values it needs. So the command a person pastes (`irm https://intentic.dev/device/<host>/<CODE> | iex`) holds
// nothing that outlives ten minutes or a single use, and nothing lands in shell history but the code.
// In memory, like the pairings the codes stand for: a daemon restart loses both, which costs a fresh command. Never
// logged, never written to /history.

// Crockford base32: no I, L, O or U, so a code read aloud or retyped from a screen has no look-alikes (the contract's).
export const CODE_ALPHABET = SHORT_CODE_ALPHABET;
// 8 characters of 32: 40 bits, walked only through the rate limit below.
const CODE_LENGTH = 8;

// What a code hands its redeemer. Each kind is one card's command: a device's install, a folder's sync, a server's
// connect. A server gets a single-use enroll token, never the sandbox's long-lived connect token.
export type CodeGrant =
    | { readonly kind: "device"; readonly pairToken: string }
    | {
          readonly kind: "sync";
          readonly pairToken: string;
          readonly mode: SyncMode;
          readonly syncDir?: string | undefined;
          readonly takeover?: boolean | undefined;
      }
    | { readonly kind: "server"; readonly connectToken: string; readonly hostName?: string | undefined };

export interface RedeemCodes {
    // Mints a code for `grant`, good for `ttlSeconds` (the lifetime of the token it stands for) and one redemption.
    readonly mint: (grant: CodeGrant, ttlSeconds: number) => string;
    // Spends the code: what it granted, or undefined when unknown, expired or already used.
    readonly redeem: (presented: string) => CodeGrant | undefined;
}

// The code as typed, read the way people retype codes: any case, one hyphen in the middle, and Crockford's reading of
// the letters the alphabet leaves out (I and L as 1, O as 0). Undefined when it cannot be a code at all.
export const normalizeCode = (presented: string): string | undefined => {
    const match = /^([0-9A-Z]{4})-?([0-9A-Z]{4})$/.exec(presented.trim().toUpperCase());
    if (match === null) {
        return undefined;
    }
    const read = `${match[1]}${match[2]}`.replaceAll(/[IL]/g, "1").replaceAll("O", "0");
    return [...read].every((char) => CODE_ALPHABET.includes(char)) ? read : undefined;
};

const freshCode = (): string => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");

export const redeemCodes = (now: () => number = Date.now): RedeemCodes => {
    const live = new Map<string, { readonly grant: CodeGrant; readonly expiresAt: number }>();
    return {
        mint: (grant, ttlSeconds) => {
            const at = now();
            // Swept on mint, the one call that is neither hot nor latency-bound, as pairings are.
            for (const [code, held] of live) {
                if (held.expiresAt <= at) {
                    live.delete(code);
                }
            }
            let code = freshCode();
            while (live.has(code)) {
                code = freshCode();
            }
            live.set(code, { grant, expiresAt: at + ttlSeconds * 1000 });
            return code;
        },
        redeem: (presented) => {
            const code = normalizeCode(presented);
            if (code === undefined) {
                return undefined;
            }
            const held = live.get(code);
            // Deleted before anything else: single use whatever the answer.
            live.delete(code);
            return held === undefined || held.expiresAt <= now() ? undefined : held.grant;
        },
    };
};

// The answer's body: `KEY=value` lines, the format the platform's setup-code claim answers in and `ic`'s kv_lines reads.
export const grantLines = (grant: CodeGrant, sandboxUrl: string): string => {
    const lines: [string, string][] = [
        ["KIND", grant.kind],
        ["SANDBOX_URL", sandboxUrl],
    ];
    if (grant.kind === "device") {
        lines.push(["PAIR_TOKEN", grant.pairToken]);
    } else if (grant.kind === "sync") {
        lines.push(["PAIR_TOKEN", grant.pairToken]);
        // Informational: the mode rides in the pairing itself, which the sandbox reads at enrollment.
        lines.push(["MODE", grant.mode]);
        if (grant.syncDir !== undefined) {
            lines.push(["SYNC_DIR", grant.syncDir]);
        }
        if (grant.takeover === true) {
            lines.push(["TAKEOVER", "1"]);
        }
    } else {
        lines.push(["CONNECT_TOKEN", grant.connectToken]);
        const zone = zoneFromUrl(sandboxUrl);
        if (zone !== undefined) {
            lines.push(["ZONE", zone]);
        }
        if (grant.hostName !== undefined) {
            lines.push(["HOST_NAME", grant.hostName]);
        }
    }
    return `${lines.map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
};

// Failed redemptions a minute: per caller, and over everyone, so 40 bits cannot be walked from one address or many.
export const REDEEM_FAILURES_PER_IP = 20;
export const REDEEM_FAILURES_OVERALL = 300;
const WINDOW_MS = 60_000;

export const INVALID_CODE = "This code is not valid any more: get a new command from the card it came from.\n";
const TOO_MANY = "Too many invalid codes were tried: wait a minute, then get a new command from the card it came from.\n";

// POST /system/redeem/{code}: public, a device's first contact with this sandbox, as the pairing redemptions are. Only
// a failure counts against the limits, and a caller already over them is refused before the code is even looked at,
// so a walk cannot keep guessing and a valid code is never spent on an answer its redeemer does not get.
export const createRedeemRoute = (deps: { readonly codes: RedeemCodes; readonly sandboxUrl: () => string; readonly now?: () => number }) => {
    const now = deps.now ?? Date.now;
    // When each recent failure happened, per caller and under "all"; a minute's worth, in memory.
    const failed = new Map<string, number[]>();
    const recent = (key: string, at: number): number[] => {
        const kept = (failed.get(key) ?? []).filter((when) => when > at - WINDOW_MS);
        if (kept.length === 0) {
            failed.delete(key);
        } else {
            failed.set(key, kept);
        }
        return kept;
    };
    const exhausted = (ip: string, at: number): boolean =>
        recent(`ip:${ip}`, at).length >= REDEEM_FAILURES_PER_IP || recent("all", at).length >= REDEEM_FAILURES_OVERALL;
    const fail = (ip: string, at: number): void => {
        for (const key of [`ip:${ip}`, "all"]) {
            failed.set(key, [...recent(key, at), at]);
        }
    };
    return (c: Context<AppEnv>): Response => {
        const at = now();
        const ip = remoteIpOf(c) ?? "unknown";
        const plain = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
        if (exhausted(ip, at)) {
            return new Response(TOO_MANY, { status: 429, headers: plain });
        }
        const grant = deps.codes.redeem(c.req.param("code") ?? "");
        if (grant === undefined) {
            fail(ip, at);
            return new Response(INVALID_CODE, { status: 404, headers: plain });
        }
        return new Response(grantLines(grant, deps.sandboxUrl()), { status: 200, headers: plain });
    };
};
