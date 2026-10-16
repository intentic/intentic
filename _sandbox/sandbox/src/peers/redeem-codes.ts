import { createHash, randomInt } from "node:crypto";
import { INVENTORY_NAME_MAX } from "@intentic/sandbox-contract/schemas/inventory";
import { SHORT_CODE_ALPHABET } from "@intentic/sandbox-contract/schemas/short-codes";
import { zoneFromUrl } from "@intentic/sandbox-contract/ids/hostnames";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { remoteIpOf } from "../http/remote-ip.js";
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
// connect. A server gets a single-use enroll token, never the sandbox's long-lived connect token, and `zone` only when
// this sandbox's address is on a domain of the owner's own (the server's tunnel goes under it with the owner's
// Cloudflare token); on an address intentic provides, the server resolves a zone of the owner's from that token.
// `hostId` is the id this sandbox gives a server of a given name (hostSshIdFromToken over its long-lived connect token),
// the one the server's tunnel, its DNS record and, on Windows, its container and volume are named for. The single-use
// token is a new one each run, so an id digested from it was too, and every run of the command made the server anew. A
// function, so the long-lived token itself never sits in a grant; absent on a sandbox that has no such token.
export type CodeGrant =
    | { readonly kind: "device"; readonly pairToken: string }
    | {
          readonly kind: "sync";
          readonly pairToken: string;
          readonly mode: SyncMode;
          readonly syncDir?: string | undefined;
          readonly takeover?: boolean | undefined;
      }
    | {
          readonly kind: "server";
          readonly connectToken: string;
          readonly hostName?: string | undefined;
          readonly zone?: string | undefined;
          readonly hostId?: ((hostName: string) => string) | undefined;
      };

export interface RedeemCodes {
    // Mints a code for `grant`, good for `ttlSeconds` (the lifetime of the token it stands for) and one redemption.
    // `onRedeem` runs when the code is redeemed in time, for a token whose clock should start there instead.
    readonly mint: (grant: CodeGrant, ttlSeconds: number, options?: { readonly onRedeem?: () => void }) => string;
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
    const live = new Map<string, { readonly grant: CodeGrant; readonly expiresAt: number; readonly onRedeem?: (() => void) | undefined }>();
    return {
        mint: (grant, ttlSeconds, options) => {
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
            live.set(code, { grant, expiresAt: at + ttlSeconds * 1000, onRedeem: options?.onRedeem });
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
            if (held === undefined || held.expiresAt <= now()) {
                return undefined;
            }
            held.onRedeem?.();
            return held.grant;
        },
    };
};

// The zone a server code hands out as ZONE: this sandbox's own, unless its address is one intentic's edge provides
// (`sandbox-<id>.<edge zone>`). That zone is the platform's, which the owner's Cloudflare token cannot reach, so the
// server's tunnel would fail "zone not found" under it; without ZONE the server resolves one from the owner's token.
// The edge's zone is read off the address the sandbox dials it at (INGRESS_URL), which the platform keeps as a label
// under that same zone, and "under it" is the platform's own `providedAddress` rule.
export const ownDomainZone = (sandboxUrl: string, ingressUrl: string): string | undefined => {
    const zone = zoneFromUrl(sandboxUrl);
    const edge = zoneFromUrl(ingressUrl);
    if (zone === undefined || (edge !== undefined && (zone === edge || zone.endsWith(`.${edge}`)))) {
        return undefined;
    }
    return zone;
};

// A server name exactly as `ic machine enroll` and connect-host.ps1 leave it once they normalize it (lowercase, `_` for
// anything else, no leading digit, never `self`). Only for such a name is the HOST_ID answered below the id of the name
// they go on to use.
const settledServerName = (name: string): boolean => name.length <= INVENTORY_NAME_MAX && /^[a-z_][a-z0-9_]*$/.test(name) && name !== "self";

// The answer's body: `KEY=value` lines, the format the platform's setup-code claim answers in and `ic`'s kv_lines reads.
// `askedName` is the name a server's script says the server will take (`?name=`), for a code minted without one: the
// person left the name to the server, and only it knows its own hostname.
export const grantLines = (grant: CodeGrant, sandboxUrl: string, askedName?: string): string => {
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
        if (grant.zone !== undefined) {
            lines.push(["ZONE", grant.zone]);
        }
        // The name the code was minted for wins: its enroll token admits that server alone. Else, where there is an id
        // to answer, the name the script asked under, which the answer then holds it to, so the server is enrolled under
        // the very name its HOST_ID was digested from.
        const asked = grant.hostId !== undefined && askedName !== undefined && settledServerName(askedName) ? askedName : undefined;
        const hostName = grant.hostName ?? asked;
        if (hostName !== undefined) {
            lines.push(["HOST_NAME", hostName]);
        }
        if (hostName !== undefined && grant.hostId !== undefined && settledServerName(hostName)) {
            lines.push(["HOST_ID", grant.hostId(hostName)]);
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

// An address is at most 45 characters (IPv6 with an IPv4 tail). A forwarded header longer than this is not one, and is
// keyed by its digest instead, so a caller padding the header cannot make each entry it leaves behind cost more.
const CALLER_KEY_MAX = 64;
const callerKey = (ip: string): string => `ip:${ip.length <= CALLER_KEY_MAX ? ip : createHash("sha256").update(ip).digest("hex")}`;

// The failure counts behind the limits above, in memory.
export interface RedeemLimits {
    // Whether this caller, or everyone together, is already over a limit.
    readonly exhausted: (ip: string, at: number) => boolean;
    readonly fail: (ip: string, at: number) => void;
    // How many entries the table holds, the overall one included: what a test reads to see it stays bounded.
    readonly size: () => number;
}

export const redeemLimits = (): RedeemLimits => {
    // When each recent failure happened, per caller and under "all"; a minute's worth. Every failure first sweeps out
    // the callers whose newest failure has left the window, so what stays is the callers that failed within the last
    // minute, which the overall limit holds to REDEEM_FAILURES_OVERALL: callers that never come back (a walk rotating
    // its forwarded address) do not pile up.
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
    const sweep = (at: number): void => {
        for (const [key, times] of failed) {
            // Appended in order, so the last one is the newest.
            if ((times.at(-1) ?? 0) <= at - WINDOW_MS) {
                failed.delete(key);
            }
        }
    };
    return {
        exhausted: (ip, at) => recent(callerKey(ip), at).length >= REDEEM_FAILURES_PER_IP || recent("all", at).length >= REDEEM_FAILURES_OVERALL,
        fail: (ip, at) => {
            sweep(at);
            for (const key of [callerKey(ip), "all"]) {
                failed.set(key, [...recent(key, at), at]);
            }
        },
        size: () => failed.size,
    };
};

// POST /system/redeem/{code}: public, a device's first contact with this sandbox, as the pairing redemptions are. Only
// a failure counts against the limits, and a caller already over them is refused before the code is even looked at,
// so a walk cannot keep guessing and a valid code is never spent on an answer its redeemer does not get.
export const createRedeemRoute = (deps: {
    readonly codes: RedeemCodes;
    readonly sandboxUrl: () => string;
    readonly now?: () => number;
    readonly limits?: RedeemLimits;
}) => {
    const now = deps.now ?? Date.now;
    const limits = deps.limits ?? redeemLimits();
    return (c: Context<AppEnv>): Response => {
        const at = now();
        const ip = remoteIpOf(c) ?? "unknown";
        const plain = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };
        if (limits.exhausted(ip, at)) {
            return new Response(TOO_MANY, { status: 429, headers: plain });
        }
        const grant = deps.codes.redeem(c.req.param("code") ?? "");
        if (grant === undefined) {
            limits.fail(ip, at);
            return new Response(INVALID_CODE, { status: 404, headers: plain });
        }
        return new Response(grantLines(grant, deps.sandboxUrl(), c.req.query("name")), { status: 200, headers: plain });
    };
};
