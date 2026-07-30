import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { exportJWK, flattenedVerify, importJWK } from "jose";
import { expect, it, vi } from "vitest";
import { obtainCertificate } from "./acme.js";

/* A fake CA, in-process, so the ORDER FLOW is exercised rather than asserted about — the parts that go wrong
 * in an ACME client are sequencing (nonce rotation, jwk-then-kid, POST-as-GET vs `{}`) and the key
 * authorization digest, and every one of them is checked here against what a real CA would enforce.
 *
 * The signatures are verified with the account's PUBLIC key, so this also proves the JWS is genuinely ES256 in
 * the P1363 form JOSE requires and not node's default DER — a mistake that produces a same-length signature
 * every real CA would reject. */

const PEM = "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----\n";
const TOKEN = "challenge-token";
const HOST = "local-0f310c3c4db4.intentic.dev";

interface Seen {
    readonly url: string;
    readonly header: Record<string, unknown>;
    readonly payload: string;
}

// A CA that walks an order from new-account to certificate. `authzStatus` lets a test drive the validation
// outcome; `nonceFailures` makes the first N posts answer badNonce, the retry every real client must handle.
const fakeCa = (opts: { authzStatus?: () => string; nonceFailures?: number } = {}) => {
    const seen: Seen[] = [];
    const issuedNonces = new Set<string>();
    const spent = new Set<string>();
    let counter = 0;
    let challengeAnswered = false;
    let remainingNonceFailures = opts.nonceFailures ?? 0;

    const mintNonce = (): string => {
        const value = `nonce-${(counter += 1)}`;
        issuedNonces.add(value);
        return value;
    };
    const respond = (body: unknown, init: { status?: number; location?: string } = {}): Response =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status: init.status ?? 200,
            headers: {
                "replay-nonce": mintNonce(),
                ...(init.location === undefined ? {} : { location: init.location }),
                "content-type": typeof body === "string" ? "application/pem-certificate-chain" : "application/json",
            },
        });

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/directory")) {
            return respond({ newNonce: "https://ca.test/nonce", newAccount: "https://ca.test/new-account", newOrder: "https://ca.test/new-order" });
        }
        if (init?.method === "HEAD") {
            return respond({});
        }
        // Every POST is a JWS: verify it the way the CA would, and record what it said.
        const jws = JSON.parse(String(init?.body)) as { protected: string; payload: string; signature: string };
        const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString()) as Record<string, unknown>;
        const key = await importJWK((header["jwk"] ?? accountPublicJwk) as Parameters<typeof importJWK>[0], "ES256");
        const verified = await flattenedVerify(jws, key);
        // A nonce is single-use, and the URL is bound into the header so a request cannot be replayed elsewhere.
        expect(issuedNonces.has(header["nonce"] as string), `unknown nonce on ${url}`).toBe(true);
        expect(spent.has(header["nonce"] as string), `replayed nonce on ${url}`).toBe(false);
        spent.add(header["nonce"] as string);
        expect(header["url"]).toBe(url);
        seen.push({ url, header, payload: new TextDecoder().decode(verified.payload) });

        if (remainingNonceFailures > 0) {
            remainingNonceFailures -= 1;
            return respond({ type: "urn:ietf:params:acme:error:badNonce", detail: "stale" }, { status: 400 });
        }
        if (url.endsWith("/new-account")) {
            return respond({ status: "valid" }, { status: 201, location: "https://ca.test/account/1" });
        }
        if (url.endsWith("/new-order")) {
            return respond(
                { status: "pending", authorizations: ["https://ca.test/authz/1"], finalize: "https://ca.test/finalize" },
                { status: 201, location: "https://ca.test/order/1" },
            );
        }
        if (url.endsWith("/authz/1")) {
            const status = challengeAnswered ? (opts.authzStatus?.() ?? "valid") : "pending";
            return respond({
                status,
                identifier: { type: "dns", value: HOST },
                challenges: [
                    { type: "http-01", url: "https://ca.test/challenge/http", token: "ignored" },
                    {
                        type: "dns-01",
                        url: "https://ca.test/challenge/dns",
                        token: TOKEN,
                        ...(status === "invalid" ? { error: { detail: "no TXT record found" } } : {}),
                    },
                ],
            });
        }
        if (url.endsWith("/challenge/dns")) {
            challengeAnswered = true;
            return respond({ status: "processing" });
        }
        if (url.endsWith("/finalize")) {
            return respond({ status: "valid", certificate: "https://ca.test/cert/1" });
        }
        if (url.endsWith("/cert/1")) {
            return respond(PEM);
        }
        return respond({ detail: `unexpected ${url}` }, { status: 404 });
    }) as unknown as typeof fetch;

    return { fetchImpl, seen };
};

const accountKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
const certificateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
// The PUBLIC half — what a CA has, and the only thing that can verify a signature.
const accountPublicJwk = await exportJWK(createPublicKey(accountKey));

/* The zone stands in for the one the challenge is published into: by default a record is visible the moment it
 * is written, and a test that cares about propagation supplies its own `resolveTxt`. The clock is virtual, so a
 * poll can reach its deadline without a test spending it. */
const run = async (
    ca: ReturnType<typeof fakeCa>,
    hooks: {
        publish?: (recordName: string, value: string) => Promise<void>;
        remove?: (recordName: string) => Promise<void>;
        resolveTxt?: (recordName: string) => Promise<string[]>;
    } = {},
) => {
    const zone = new Map<string, string>();
    const publish = hooks.publish;
    let clock = 0;
    return obtainCertificate({
        directoryUrl: "https://ca.test/directory",
        accountKey,
        certificateKey,
        hostnames: [HOST],
        publishChallenge: async (recordName, value) => {
            zone.set(recordName, value);
            await publish?.(recordName, value);
        },
        removeChallenge: hooks.remove ?? vi.fn(async () => undefined),
        resolveTxt: hooks.resolveTxt ?? (async (recordName) => (zone.has(recordName) ? [zone.get(recordName)!] : [])),
        fetchImpl: ca.fetchImpl,
        wait: async (ms) => {
            clock += ms;
        },
        now: () => clock,
    });
};

it("walks an order to a certificate, publishing the digest the spec asks for", async () => {
    const publish = vi.fn(async () => undefined);
    const ca = fakeCa();
    expect(await run(ca, { publish })).toEqual({ certificate: PEM });

    // The TXT value is SHA-256 of `<token>.<account thumbprint>`, base64url — NOT the key authorization
    // itself, which is the single most common way a DNS-01 client fails validation against a real CA.
    const { calculateJwkThumbprint } = await import("jose");
    const expected = createHash("sha256")
        .update(`${TOKEN}.${await calculateJwkThumbprint(accountPublicJwk, "sha256")}`)
        .digest("base64url");
    expect(publish).toHaveBeenCalledWith(`_acme-challenge.${HOST}`, expected);
});

it("identifies by jwk until the account exists, then by kid — never both", async () => {
    const ca = fakeCa();
    await run(ca);
    const [first, ...rest] = ca.seen;
    expect(first).toBeDefined();
    expect(first!.url).toBe("https://ca.test/new-account");
    expect(first!.header["kid"]).toBeUndefined();
    // A jwk header carrying `d` would hand the CA our private key.
    const jwk = first!.header["jwk"] as Record<string, unknown> | undefined;
    expect(jwk).toBeDefined();
    expect(jwk!["d"]).toBeUndefined();
    for (const request of rest) {
        expect(request.header["kid"], `${request.url} should identify by kid`).toBe("https://ca.test/account/1");
        expect(request.header["jwk"], `${request.url} should not resend the jwk`).toBeUndefined();
    }
});

it("reads protected resources with POST-as-GET and answers the challenge with {}", async () => {
    const ca = fakeCa();
    await run(ca);
    // An empty payload is a read; `{}` is "I am ready". Posting `{}` to an authorization is a 400 from a real CA.
    expect(ca.seen.filter((request) => request.url.endsWith("/authz/1")).every((request) => request.payload === "")).toBe(true);
    expect(ca.seen.find((request) => request.url.endsWith("/cert/1"))?.payload).toBe("");
    expect(ca.seen.find((request) => request.url.endsWith("/challenge/dns"))?.payload).toBe("{}");
    // Finalize carries the CSR, base64url, unpadded.
    const finalize = JSON.parse(ca.seen.find((request) => request.url.endsWith("/finalize"))!.payload) as { csr: string };
    expect(finalize.csr).toMatch(/^[A-Za-z0-9_-]+$/);
});

it("retries a badNonce once with the fresh nonce, the way a CA expects", async () => {
    const ca = fakeCa({ nonceFailures: 1 });
    expect(await run(ca)).toEqual({ certificate: PEM });
    // Two attempts at the first endpoint, with DIFFERENT nonces — the fake CA rejects any replay outright.
    const accountAttempts = ca.seen.filter((request) => request.url.endsWith("/new-account"));
    expect(accountAttempts).toHaveLength(2);
    expect(accountAttempts[0]?.header["nonce"]).not.toBe(accountAttempts[1]?.header["nonce"]);
});

it("fails with the CA's own reason when validation is refused, and still cleans up", async () => {
    const remove = vi.fn(async () => undefined);
    await expect(run(fakeCa({ authzStatus: () => "invalid" }), { remove })).rejects.toThrowError(/no TXT record found/);
    // The challenge record must not survive a failed order — the next attempt publishes a different value.
    expect(remove).toHaveBeenCalledWith(`_acme-challenge.${HOST}`);
});

it("never asks the CA to look before the zone actually serves the record", async () => {
    const ca = fakeCa();
    /* The failure this prevents: a zone API returns once it has ACCEPTED the write, seconds before its
     * nameservers answer with the record, and a CA that looks into that gap marks the authorization `invalid`
     * for good — `NXDOMAIN looking up TXT` is not a retryable "not yet". So an unpublished record has to fail
     * here, with the CA never told to validate. */
    await expect(run(ca, { resolveTxt: async () => [] })).rejects.toThrowError(`timed out waiting for publication of _acme-challenge.${HOST}`);
    expect(ca.seen.some((request) => request.url.endsWith("/challenge/dns"))).toBe(false);
});

it("waits out the gap between the zone accepting the record and serving it", async () => {
    const ca = fakeCa();
    let value: string | undefined;
    let lookups = 0;
    // Invisible for the first two lookups, exactly as a zone mid-propagation is.
    const resolveTxt = async (): Promise<string[]> => (++lookups > 2 && value !== undefined ? [value] : []);
    const result = await run(ca, { publish: async (_recordName, published) => void (value = published), resolveTxt });
    expect(result).toEqual({ certificate: PEM });
    expect(lookups).toBe(3);
    // And having waited, it does go on to answer the challenge — the wait must not become its own dead end.
    expect(ca.seen.some((request) => request.url.endsWith("/challenge/dns"))).toBe(true);
});

it("never lets a failed cleanup spoil an issued certificate", async () => {
    const remove = vi.fn(async () => {
        throw new Error("zone unreachable");
    });
    expect(await run(fakeCa(), { remove })).toEqual({ certificate: PEM });
});
