import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import {
    CODE_ALPHABET,
    type CodeGrant,
    createRedeemRoute,
    INVALID_CODE,
    normalizeCode,
    REDEEM_FAILURES_OVERALL,
    REDEEM_FAILURES_PER_IP,
    type RedeemLimits,
    redeemCodes,
    redeemLimits,
} from "./redeem-codes.js";

// The short codes a copy-paste command carries instead of a token: minted beside one, redeemed once at the sandbox.

const DEVICE: CodeGrant = { kind: "device", pairToken: "pair-device" };

test("a code is 8 characters of Crockford base32, which leaves out I, L, O and U", () => {
    expect(CODE_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    const codes = redeemCodes();
    for (let index = 0; index < 200; index++) {
        expect(codes.mint(DEVICE, 600)).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    }
});

test("a code redeems once, and is refused after", () => {
    const codes = redeemCodes();
    const code = codes.mint(DEVICE, 600);
    expect(codes.redeem(code)).toEqual(DEVICE);
    expect(codes.redeem(code)).toBeUndefined();
});

test("a code expires with the token it stands for, and an expired one is spent too", () => {
    let now = 1_000_000;
    const codes = redeemCodes(() => now);
    const fresh = codes.mint(DEVICE, 600);
    const stale = codes.mint(DEVICE, 600);
    now += 599_000;
    expect(codes.redeem(fresh)).toEqual(DEVICE);
    now += 1_000;
    expect(codes.redeem(stale)).toBeUndefined();
});

test("a code is read the way people retype it: any case, one hyphen in the middle, I/L as 1 and O as 0", () => {
    const codes = redeemCodes();
    const code = codes.mint(DEVICE, 600);
    expect(codes.redeem(`${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`)).toEqual(DEVICE);
    expect(normalizeCode("ab1c-d0ef")).toBe("AB1CD0EF");
    expect(normalizeCode("ABlC-DoEF")).toBe("AB1CD0EF");
    expect(normalizeCode("ABIC DOEF")).toBeUndefined();
    expect(normalizeCode("AB-CDEFGH")).toBeUndefined();
    expect(normalizeCode("ABCDEFGU")).toBeUndefined();
    expect(normalizeCode("ABCDEFG")).toBeUndefined();
});

test("a code redeemed in time tells whoever minted it, once; an expired or spent one does not", () => {
    let now = 1_000_000;
    const codes = redeemCodes(() => now);
    const redeemed: string[] = [];
    const fresh = codes.mint(DEVICE, 600, { onRedeem: () => redeemed.push("fresh") });
    const stale = codes.mint(DEVICE, 600, { onRedeem: () => redeemed.push("stale") });
    expect(codes.redeem(fresh)).toEqual(DEVICE);
    expect(codes.redeem(fresh)).toBeUndefined();
    now += 600_000;
    expect(codes.redeem(stale)).toBeUndefined();
    expect(redeemed).toEqual(["fresh"]);
});

const URL = "https://sandbox-abc.example.dev";

const redeemer = (codes = redeemCodes(), limits?: RedeemLimits) => {
    const app = new Hono<AppEnv>().post("/system/redeem/:code", createRedeemRoute({ codes, sandboxUrl: () => URL, ...(limits === undefined ? {} : { limits }) }));
    const redeem = async (code: string, ip = "198.51.100.7") => {
        const response = await app.request(`/system/redeem/${code}`, { method: "POST", headers: { "cf-connecting-ip": ip } });
        return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
    };
    return { codes, redeem };
};

test("a device code redeems for this sandbox's URL and the pairing token, as KEY=value lines", async () => {
    const { codes, redeem } = redeemer();
    const answer = await redeem(codes.mint(DEVICE, 600));
    expect(answer).toEqual({ status: 200, type: "text/plain; charset=utf-8", body: `KIND=device\nSANDBOX_URL=${URL}\nPAIR_TOKEN=pair-device\n` });
});

test("a sync code carries the folder, takeover and mode it was minted with", async () => {
    const { codes, redeem } = redeemer();
    const full = await redeem(codes.mint({ kind: "sync", pairToken: "pair-sync", mode: "mirror", syncDir: "~/intentic/web", takeover: true }, 600));
    expect(full.body).toBe(`KIND=sync\nSANDBOX_URL=${URL}\nPAIR_TOKEN=pair-sync\nMODE=mirror\nSYNC_DIR=~/intentic/web\nTAKEOVER=1\n`);
    const bare = await redeem(codes.mint({ kind: "sync", pairToken: "pair-sync", mode: "sync" }, 600));
    expect(bare.body).toBe(`KIND=sync\nSANDBOX_URL=${URL}\nPAIR_TOKEN=pair-sync\nMODE=sync\n`);
});

test("a used, unknown or malformed code answers 404 with one plain sentence", async () => {
    const { codes, redeem } = redeemer();
    const code = codes.mint(DEVICE, 600);
    expect((await redeem(code)).status).toBe(200);
    for (const tried of [code, "ZZZZZZZZ", "not-a-code"]) {
        expect(await redeem(tried)).toEqual({ status: 404, type: "text/plain; charset=utf-8", body: INVALID_CODE });
    }
});

test("failed redemptions are limited per caller, and a caller over the limit cannot spend a valid code", async () => {
    const { codes, redeem } = redeemer();
    for (let index = 0; index < REDEEM_FAILURES_PER_IP; index++) {
        expect((await redeem("ZZZZZZZZ")).status).toBe(404);
    }
    const code = codes.mint(DEVICE, 600);
    expect((await redeem(code)).status).toBe(429);
    // Another caller is not held back by the first one's guesses, and the valid code was not spent by the refusal.
    expect((await redeem(code, "203.0.113.9")).status).toBe(200);
});

test("failed redemptions are limited over everyone, so a walk from many addresses stops too", async () => {
    const { codes, redeem } = redeemer();
    for (let index = 0; index < REDEEM_FAILURES_OVERALL; index++) {
        await redeem("ZZZZZZZZ", `10.0.${Math.floor(index / 250)}.${index % 250}`);
    }
    expect((await redeem(codes.mint(DEVICE, 600), "192.0.2.1")).status).toBe(429);
});

test("the failure table forgets callers once their minute has passed, however many rotate through it", async () => {
    let now = 1_000_000;
    const limits = redeemLimits();
    const app = new Hono<AppEnv>().post("/system/redeem/:code", createRedeemRoute({ codes: redeemCodes(() => now), sandboxUrl: () => URL, now: () => now, limits }));
    // A walk that rotates its forwarded address on every guess, each one padded long, for twenty minutes.
    const padding = "x".repeat(4000);
    for (let minute = 0; minute < 20; minute++) {
        for (let index = 0; index < REDEEM_FAILURES_OVERALL; index++) {
            await app.request("/system/redeem/ZZZZZZZZ", { method: "POST", headers: { "cf-connecting-ip": `${padding}-${minute}-${index}` } });
        }
        now += 61_000;
    }
    expect(limits.size()).toBeLessThanOrEqual(REDEEM_FAILURES_OVERALL + 1);
});

test("callers whose forwarded address is too long to be one still keep a bucket each", async () => {
    const { codes, redeem } = redeemer();
    const padding = "y".repeat(200);
    for (let index = 0; index < REDEEM_FAILURES_PER_IP; index++) {
        expect((await redeem("ZZZZZZZZ", `${padding}-a`)).status).toBe(404);
    }
    const code = codes.mint(DEVICE, 600);
    expect((await redeem(code, `${padding}-a`)).status).toBe(429);
    expect((await redeem(code, `${padding}-b`)).status).toBe(200);
});
