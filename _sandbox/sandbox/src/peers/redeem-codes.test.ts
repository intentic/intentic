import { Hono } from "hono";
import type { AppEnv } from "../app-env.js";
import {
    CODE_ALPHABET,
    type CodeGrant,
    createRedeemRoute,
    INVALID_CODE,
    normalizeCode,
    ownDomainZone,
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

// The zone a server code hands out is for the server's tunnel, made with the owner's own Cloudflare token: the zone of
// an address intentic provides is the platform's, which that token cannot reach.
test("a server's zone is the sandbox's own domain, never the zone of the edge that provides its address", () => {
    const edge = "https://ingress.sbx.intentic.dev";
    expect(ownDomainZone("https://sandbox-abc.sbx.intentic.dev", edge)).toBeUndefined();
    expect(ownDomainZone("https://sandbox-abc.eu.sbx.intentic.dev", edge)).toBeUndefined();
    expect(ownDomainZone("https://sandbox-abc.example.dev", edge)).toBe("example.dev");
    // A zone that merely ends in the same letters is not under it.
    expect(ownDomainZone("https://sandbox-abc.notsbx.intentic.dev", edge)).toBe("notsbx.intentic.dev");
    // No edge to dial: the address is one the owner attached.
    expect(ownDomainZone("https://sandbox-abc.example.dev", "")).toBe("example.dev");
    expect(ownDomainZone("", edge)).toBeUndefined();
});

const URL = "https://sandbox-abc.example.dev";

const redeemer = (codes = redeemCodes(), limits?: RedeemLimits) => {
    const app = new Hono<AppEnv>().post("/system/redeem/:code", createRedeemRoute({ codes, sandboxUrl: () => URL, ...(limits === undefined ? {} : { limits }) }));
    const redeem = async (code: string, ip = "198.51.100.7", query = "") => {
        const response = await app.request(`/system/redeem/${code}${query}`, { method: "POST", headers: { "cf-connecting-ip": ip } });
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

test("a server code carries the single-use enroll token and the zone, never a Cloudflare token", async () => {
    const { codes, redeem } = redeemer();
    const answer = await redeem(codes.mint({ kind: "server", connectToken: "enroll-once", hostName: "web", zone: "example.dev" }, 600));
    expect(answer.body).toBe(`KIND=server\nSANDBOX_URL=${URL}\nCONNECT_TOKEN=enroll-once\nZONE=example.dev\nHOST_NAME=web\n`);
});

test("a server code minted without a zone hands out none, whatever the sandbox's address", async () => {
    const { codes, redeem } = redeemer();
    const answer = await redeem(codes.mint({ kind: "server", connectToken: "enroll-once", hostName: "web" }, 600));
    expect(answer.body).toBe(`KIND=server\nSANDBOX_URL=${URL}\nCONNECT_TOKEN=enroll-once\nHOST_NAME=web\n`);
});

// What a server's tunnel, DNS record and Windows container are named for: a stand-in for hostSshIdFromToken over the
// sandbox's long-lived connect token, which the grant holds only as this function.
const hostId = (name: string): string => `id-of-${name}`;

test("a server code answers the HOST_ID of the name it was minted for, whatever name the script asks under", async () => {
    const { codes, redeem } = redeemer();
    const named = await redeem(codes.mint({ kind: "server", connectToken: "enroll-once", hostName: "web_1", hostId }, 600), undefined, "?name=laptop");
    expect(named.body).toBe(`KIND=server\nSANDBOX_URL=${URL}\nCONNECT_TOKEN=enroll-once\nHOST_NAME=web_1\nHOST_ID=id-of-web_1\n`);
});

test("a server code minted without a name holds the server to the name its script asks under, and answers that name's HOST_ID", async () => {
    const { codes, redeem } = redeemer();
    const unnamed = () => codes.mint({ kind: "server", connectToken: "enroll-once", hostId }, 600);
    expect((await redeem(unnamed(), undefined, "?name=laptop")).body).toBe(
        `KIND=server\nSANDBOX_URL=${URL}\nCONNECT_TOKEN=enroll-once\nHOST_NAME=laptop\nHOST_ID=id-of-laptop\n`,
    );
    // No name asked, or one the scripts would still change (and so not use as it stands): the answer is the one before
    // HOST_ID, and the script names the server itself.
    for (const query of ["", "?name=", "?name=Laptop", "?name=1box", "?name=self", "?name=my%20box", `?name=${"a".repeat(61)}`]) {
        expect((await redeem(unnamed(), undefined, query)).body).toBe(`KIND=server\nSANDBOX_URL=${URL}\nCONNECT_TOKEN=enroll-once\n`);
    }
});

test("a server code minted on a sandbox with no long-lived connect token answers no HOST_ID and takes no asked name", async () => {
    const { codes, redeem } = redeemer();
    const unnamed = await redeem(codes.mint({ kind: "server", connectToken: "enroll-once" }, 600), undefined, "?name=laptop");
    expect(unnamed.body).toBe(`KIND=server\nSANDBOX_URL=${URL}\nCONNECT_TOKEN=enroll-once\n`);
    const named = await redeem(codes.mint({ kind: "server", connectToken: "enroll-once", hostName: "web" }, 600), undefined, "?name=laptop");
    expect(named.body).toBe(`KIND=server\nSANDBOX_URL=${URL}\nCONNECT_TOKEN=enroll-once\nHOST_NAME=web\n`);
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
