import { createHash, createPublicKey, generateKeyPairSync, type JsonWebKey, verify } from "node:crypto";
import { obtainCertificate, PROVIDER_SETTLE_MS } from "./acme.js";
import type { TxtLookup } from "./authoritative-dns.js";

// In-process fake CA exercising ACME's real failure modes: nonce rotation, jwk-then-kid, POST-as-GET vs `{}`, and the
// digest. Verifies signatures with the account's public key, proving real ES256/P1363, not node's DER default.

const PEM = "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nissuer\n-----END CERTIFICATE-----\n";
const TOKEN = "challenge-token";
const HOST = "0f310c3c4db4.local.intentic.dev";

interface Seen {
    readonly url: string;
    readonly header: Record<string, unknown>;
    readonly payload: string;
}

// Walks an order from new-account to certificate; `authzStatus` drives the validation outcome, `nonceFailures` makes
// the first N posts answer badNonce.
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
        // Every POST is a JWS: verified the way a real CA would, and recorded.
        const jws = JSON.parse(String(init?.body)) as { protected: string; payload: string; signature: string };
        const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString()) as Record<string, unknown>;
        const key = createPublicKey({ key: (header["jwk"] ?? accountPublicJwk) as JsonWebKey, format: "jwk" });
        const signed = Buffer.from(`${jws.protected}.${jws.payload}`, "ascii");
        expect(verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(jws.signature, "base64url")), `bad signature on ${url}`).toBe(true);
        const verified = { payload: Buffer.from(jws.payload, "base64url") };
        // A nonce is single-use, and the URL is bound into the header so a request can't be replayed elsewhere.
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
// Public half: what a CA has, and the only thing that can verify a signature.
const accountPublicJwk = createPublicKey(accountKey).export({ format: "jwk" });

// Stands in for the zone: a record is visible the moment it's written unless a test overrides `resolveTxt`. The clock
// is virtual, so a poll can reach its deadline without the test spending real time.
const run = async (
    ca: ReturnType<typeof fakeCa>,
    hooks: {
        publish?: (recordName: string, value: string) => Promise<void>;
        remove?: (recordName: string) => Promise<void>;
        resolveTxt?: (recordName: string) => Promise<TxtLookup>;
        confirmChallenge?: (recordName: string, value: string) => Promise<boolean>;
        warn?: (message: string) => void;
        // Every wait the order asked for, in order.
        waits?: number[];
    } = {},
) => {
    const zone = new Map<string, string>();
    const publish = hooks.publish;
    let clock = 0;
    const options: Parameters<typeof obtainCertificate>[0] = {
        directoryUrl: "https://ca.test/directory",
        accountKey,
        certificateKey,
        hostnames: [HOST],
        publishChallenge: async (recordName, value) => {
            zone.set(recordName, value);
            await publish?.(recordName, value);
        },
        removeChallenge: hooks.remove ?? jest.fn(async () => undefined),
        resolveTxt: hooks.resolveTxt ?? (async (recordName) => ({ values: zone.has(recordName) ? [zone.get(recordName)!] : [], reached: "all" })),
        warn: hooks.warn ?? (() => undefined),
        fetchImpl: ca.fetchImpl,
        wait: async (ms) => {
            hooks.waits?.push(ms);
            clock += ms;
        },
        now: () => clock,
    };
    // Left out rather than stubbed when a test gives none: the order must behave exactly as it did before the option.
    return obtainCertificate(hooks.confirmChallenge === undefined ? options : { ...options, confirmChallenge: hooks.confirmChallenge });
};

it("walks an order to a certificate, publishing the digest the spec asks for", async () => {
    const publish = jest.fn(async () => undefined);
    const ca = fakeCa();
    expect(await run(ca, { publish })).toEqual({ certificate: PEM });

    // TXT value is sha256 of `<token>.<thumbprint>`, base64url — not the key authorization itself. The thumbprint is
    // RFC 7638's, spelled out: the required members in lexicographic order, no whitespace.
    const { crv, kty, x, y } = accountPublicJwk;
    const thumbprint = createHash("sha256").update(`{"crv":"${crv}","kty":"${kty}","x":"${x}","y":"${y}"}`).digest("base64url");
    const expected = createHash("sha256").update(`${TOKEN}.${thumbprint}`).digest("base64url");
    expect(publish).toHaveBeenCalledWith(`_acme-challenge.${HOST}`, expected);
});

it("identifies by jwk until the account exists, then by kid: never both", async () => {
    const ca = fakeCa();
    await run(ca);
    const [first, ...rest] = ca.seen;
    expect(first).toMatchObject({ url: "https://ca.test/new-account" });
    expect(first!.header["kid"]).toBeUndefined();
    // A jwk header carrying `d` would hand the CA our private key.
    const jwk = first!.header["jwk"] as Record<string, unknown> | undefined;
    expect(jwk!["d"]).toBeUndefined();
    for (const request of rest) {
        expect(request.header["kid"], `${request.url} should identify by kid`).toBe("https://ca.test/account/1");
        expect(request.header["jwk"], `${request.url} should not resend the jwk`).toBeUndefined();
    }
});

it("reads protected resources with POST-as-GET and answers the challenge with {}", async () => {
    const ca = fakeCa();
    await run(ca);
    // Empty payload is a read; `{}` means ready. Posting `{}` to an authorization instead gets a real CA's 400.
    expect(ca.seen.filter((request) => request.url.endsWith("/authz/1")).every((request) => request.payload === "")).toBe(true);
    expect(ca.seen.find((request) => request.url.endsWith("/cert/1"))?.payload).toBe("");
    expect(ca.seen.find((request) => request.url.endsWith("/challenge/dns"))?.payload).toBe("{}");
    // Finalize carries the CSR as base64url, unpadded.
    const finalize = JSON.parse(ca.seen.find((request) => request.url.endsWith("/finalize"))!.payload) as { csr: string };
    expect(finalize.csr).toMatch(/^[A-Za-z0-9_-]+$/);
});

it("retries a badNonce once with the fresh nonce, the way a CA expects", async () => {
    const ca = fakeCa({ nonceFailures: 1 });
    expect(await run(ca)).toEqual({ certificate: PEM });
    // Two attempts at the first endpoint with different nonces: the fake CA rejects any replay outright.
    const accountAttempts = ca.seen.filter((request) => request.url.endsWith("/new-account"));
    expect(accountAttempts).toHaveLength(2);
    expect(accountAttempts[0]?.header["nonce"]).not.toBe(accountAttempts[1]?.header["nonce"]);
});

it("fails with the CA's own reason when validation is refused, and still cleans up", async () => {
    const remove = jest.fn(async () => undefined);
    await expect(run(fakeCa({ authzStatus: () => "invalid" }), { remove })).rejects.toThrowError(/no TXT record found/);
    // The challenge record must not survive a failed order, so the next attempt can publish a different value.
    expect(remove).toHaveBeenCalledWith(`_acme-challenge.${HOST}`);
});

const unreachable = async (): Promise<TxtLookup> => ({ values: [], reached: "none" });

it("never asks the CA to look before the zone actually serves the record", async () => {
    const ca = fakeCa();
    await expect(run(ca, { resolveTxt: unreachable })).rejects.toThrowError(`timed out waiting for publication of _acme-challenge.${HOST}`);
    expect(ca.seen.some((request) => request.url.endsWith("/challenge/dns"))).toBe(false);
});

it("waits out the gap between the zone accepting the record and serving it", async () => {
    const ca = fakeCa();
    let value: string | undefined;
    let lookups = 0;
    // Invisible for the first two lookups, as in a zone mid-propagation.
    const resolveTxt = async (): Promise<TxtLookup> => ({ values: ++lookups > 2 && value !== undefined ? [value] : [], reached: "all" });
    const result = await run(ca, { publish: async (_recordName, published) => void (value = published), resolveTxt });
    expect(result).toEqual({ certificate: PEM });
    expect(lookups).toBe(3);
    // The wait must not become its own dead end: confirms the challenge was still answered after it.
    expect(ca.seen.some((request) => request.url.endsWith("/challenge/dns"))).toBe(true);
});

// A host whose network blocks direct DNS never sees the zone's nameservers; the provider's read-back stands in for them.
describe("when this host cannot see the zone's nameservers", () => {
    it("takes the provider's confirmation, but tells the CA only after the settle delay", async () => {
        const ca = fakeCa();
        const waits: number[] = [];
        const warn = jest.fn();
        let published: string | undefined;
        let settledBeforeTheCaLooked = false;
        // SAFETY: a fetch that only ever takes a URL and init, the two the order passes; the fake CA reads nothing else.
        const watched = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            if (String(input).endsWith("/challenge/dns")) {
                settledBeforeTheCaLooked = waits.includes(PROVIDER_SETTLE_MS);
            }
            return ca.fetchImpl(input, init);
        }) as typeof fetch;
        const confirmChallenge = jest.fn(async (_recordName: string, value: string) => value === published);
        const result = await run(
            { ...ca, fetchImpl: watched },
            { publish: async (_recordName, value) => void (published = value), resolveTxt: unreachable, confirmChallenge, warn, waits },
        );
        expect(result).toEqual({ certificate: PEM });
        expect(confirmChallenge).toHaveBeenCalledWith(`_acme-challenge.${HOST}`, published);
        expect(settledBeforeTheCaLooked).toBe(true);
        // The warning names which way DNS failed, so an operator can tell a blocked network from a slow zone.
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/none of the zone's nameservers answered this host/));
    });

    it("fails as before when the provider does not confirm the record either", async () => {
        const ca = fakeCa();
        const confirmChallenge = jest.fn(async () => false);
        await expect(run(ca, { resolveTxt: unreachable, confirmChallenge })).rejects.toThrowError(`timed out waiting for publication of _acme-challenge.${HOST}`);
        expect(confirmChallenge).toHaveBeenCalledTimes(1);
        expect(ca.seen.some((request) => request.url.endsWith("/challenge/dns"))).toBe(false);
    });

    it("fails as before when the provider cannot be asked", async () => {
        const ca = fakeCa();
        const confirmChallenge = jest.fn(async () => {
            throw new Error("zone API unreachable");
        });
        await expect(run(ca, { resolveTxt: unreachable, confirmChallenge })).rejects.toThrowError(`timed out waiting for publication of _acme-challenge.${HOST}`);
        expect(ca.seen.some((request) => request.url.endsWith("/challenge/dns"))).toBe(false);
    });

    it("fails as before with no provider confirmation to ask", async () => {
        const ca = fakeCa();
        const waits: number[] = [];
        await expect(run(ca, { resolveTxt: unreachable, waits })).rejects.toThrowError(`timed out waiting for publication of _acme-challenge.${HOST}`);
        expect(waits).not.toContain(PROVIDER_SETTLE_MS);
    });

    it("skips the provider and the settle delay when DNS shows the record", async () => {
        const waits: number[] = [];
        const confirmChallenge = jest.fn(async () => true);
        expect(await run(fakeCa(), { confirmChallenge, waits })).toEqual({ certificate: PEM });
        expect(confirmChallenge).not.toHaveBeenCalled();
        expect(waits).not.toContain(PROVIDER_SETTLE_MS);
    });
});

it("re-sends a request that never reached the CA", async () => {
    const ca = fakeCa();
    let failures = 2;
    const flaky = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (failures > 0) {
            failures -= 1;
            throw new TypeError("fetch failed");
        }
        return ca.fetchImpl(input, init);
    }) as typeof fetch;
    expect(await run({ ...ca, fetchImpl: flaky })).toEqual({ certificate: PEM });
    expect(failures).toBe(0);
});

it("gives up on a transport that never comes back, rather than retrying forever", async () => {
    const dead = (async () => {
        throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(run({ ...fakeCa(), fetchImpl: dead })).rejects.toThrowError("fetch failed");
});

it("lets an HTTP error status through untouched: that is the CA answering, not a lost connection", async () => {
    const ca = fakeCa();
    let accountAttempts = 0;
    const refusing = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(input).endsWith("/new-account")) {
            accountAttempts += 1;
            return new Response(JSON.stringify({ detail: "too many registrations for this IP" }), { status: 429, headers: { "replay-nonce": "n" } });
        }
        return ca.fetchImpl(input, init);
    }) as typeof fetch;
    await expect(run({ ...ca, fetchImpl: refusing })).rejects.toThrowError(/too many registrations/);
    // Retrying a rate limit only turns one refusal into a ban.
    expect(accountAttempts).toBe(1);
});

it("never lets a failed cleanup spoil an issued certificate", async () => {
    const remove = jest.fn(async () => {
        throw new Error("zone unreachable");
    });
    expect(await run(fakeCa(), { remove })).toEqual({ certificate: PEM });
});
