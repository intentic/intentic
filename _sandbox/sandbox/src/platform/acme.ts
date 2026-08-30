import { createHash, type KeyObject } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { calculateJwkThumbprint, exportJWK, FlattenedSign } from "jose";
import { resolveTxtAuthoritatively } from "./authoritative-dns.js";
import { base64Url, buildCsr } from "./csr.js";

/* An ACME client (RFC 8555), DNS-01 only, no dependencies beyond `jose`, which the daemon already carries for
 * verifying Google ID tokens, and which supplies the two things worth not re-deriving: JWS signing in the
 * P1363 form JOSE requires (node's default is DER, which is the same length and silently wrong here) and the
 * JWK thumbprint the key authorization is built from.
 *
 * DNS-01 rather than HTTP-01 because the name being certified, <id>.local.<zone>, resolves to 127.0.0.1.
 * There is no address on the public internet for a CA to reach, so proving control has to happen in the zone,
 * which is why the challenge is published through a caller-supplied hook: the sandbox holds no token for the
 * zone on the intentic path and relays to the platform, while nothing here needs to know which it is.
 *
 * Everything that talks to the network is injected (`fetchImpl`, the publish/remove hooks, `wait`), so the
 * whole order flow is exercised in-process against a fake CA, see acme.test.ts. */

// How long to keep asking whether the CA has validated the challenge before giving up.
const VALIDATION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

/* How long to wait for the challenge record to become visible on the zone's own nameservers before telling the
 * CA it is there. Generous, because everything about this is asymmetric: waiting a few seconds too long costs
 * a few seconds, while asking too early costs the whole issuance AND poisons the retry, a CA that looks and
 * misses marks the authorization `invalid` terminally (no amount of later polling recovers it) and its
 * resolvers then negative-cache the miss for the zone's SOA minimum, half an hour on Cloudflare. */
const PUBLICATION_TIMEOUT_MS = 90_000;
const PUBLICATION_INTERVAL_MS = 2_000;

// How many times a request that never reached the CA is re-sent, and how long between. Three is sized to the
// observed shape of the problem rather than chosen for luck: the connection AFTER a slow one is consistently
// fast, so the second attempt is the one that lands and the third is the margin.
const TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_RETRY_MS = 2_000;

// Let's Encrypt's production directory. The staging directory is the same shape and is what a first real run
// should point at, its certificates are untrusted, but its rate limits are the ones you want to hit.
export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

interface Directory {
    readonly newNonce: string;
    readonly newAccount: string;
    readonly newOrder: string;
}

export interface AcmeOptions {
    readonly directoryUrl: string;
    // The ACME ACCOUNT key, identifies us to the CA across orders and renewals. Distinct from the
    // certificate key: the CA rejects a CSR signed by the account key (RFC 8555 §11.1).
    readonly accountKey: KeyObject;
    // The key the certificate will attest. Never leaves this process, only its public half, inside the CSR.
    readonly certificateKey: KeyObject;
    readonly hostnames: readonly string[];
    // Publish `_acme-challenge.<host>` TXT = `value`, and remove it afterwards. Removal is best-effort: a
    // stale challenge record is untidy, not dangerous, and must never fail an otherwise-issued certificate.
    readonly publishChallenge: (recordName: string, value: string) => Promise<void>;
    readonly removeChallenge: (recordName: string) => Promise<void>;
    // The TXT values a name currently serves, used to confirm the challenge is live before the CA is asked to
    // look at it. Authoritative by default; injected so the order flow is testable without a zone.
    readonly resolveTxt?: (recordName: string) => Promise<string[]>;
    readonly fetchImpl?: typeof fetch;
    readonly wait?: (ms: number) => Promise<void>;
    // Epoch ms, injected so the validation deadline is testable without a clock.
    readonly now?: () => number;
}

// A JSON body, or undefined when the response carries none (finalize's 200 with a certificate URL, say).
const jsonOf = async (response: Response): Promise<Record<string, unknown>> => {
    const text = await response.text();
    if (text === "") {
        return {};
    }
    try {
        return JSON.parse(text) as Record<string, unknown>;
    } catch {
        return {};
    }
};

// The CA's own error text, so a failure names what the CA objected to rather than a bare status. ACME problem
// documents are RFC 7807: `detail` is the human sentence, `type` the machine tag.
const problemOf = async (response: Response): Promise<string> => {
    const body = await jsonOf(response);
    const detail = typeof body["detail"] === "string" ? body["detail"] : undefined;
    const type = typeof body["type"] === "string" ? body["type"] : undefined;
    return detail ?? type ?? `HTTP ${response.status}`;
};

export const obtainCertificate = async (options: AcmeOptions): Promise<{ certificate: string }> => {
    const resolveTxt = options.resolveTxt ?? resolveTxtAuthoritatively;
    const wait = options.wait ?? ((ms: number) => sleep(ms));
    const now = options.now ?? (() => Date.now());
    const transport = options.fetchImpl ?? fetch;
    /* Retry a connection that was never made, and only that. Issuance runs at boot and then on a slow cycle,
     * so its first request is always the one going down a long-idle egress path, and that is routinely slower
     * than the 10s undici allows a connect. One such moment used to cost the whole certificate.
     *
     * A REJECTED fetch is the CA never having heard us, so re-sending is safe: nothing was delivered, and a
     * request that somehow was spends its nonce, which the badNonce path below already re-signs and resends.
     * An HTTP error status is a different thing entirely, that is the CA answering, and every caller below
     * reads it, so it must arrive intact rather than be retried into a rate limit. */
    const doFetch = async (input: string, init?: RequestInit): Promise<Response> => {
        for (let attempt = 1; ; attempt += 1) {
            try {
                // oxlint-disable-next-line eslint/no-await-in-loop -- retries are sequential by definition
                return await transport(input, init);
            } catch (error) {
                if (attempt >= TRANSPORT_ATTEMPTS) {
                    throw error;
                }
                // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
                await wait(TRANSPORT_RETRY_MS);
            }
        }
    };
    const accountJwk = await exportJWK(options.accountKey);
    // The thumbprint is RFC 7638: only the required members are hashed, so passing the private JWK yields the
    // same value as the public one, and the key authorization below must match what the CA recomputes.
    const thumbprint = await calculateJwkThumbprint(accountJwk, "sha256");
    // The public half only, a JWS `jwk` header carrying `d` would hand the CA our private key. Every member
    // is present on any EC key; asserting it here turns "the caller passed something else" into a clear
    // failure at the top rather than a rejected signature four requests later.
    const { crv, kty, x, y } = accountJwk;
    if (crv === undefined || kty === undefined || x === undefined || y === undefined) {
        throw new Error("the ACME account key must be an EC key");
    }
    const publicJwk = { crv, kty, x, y };

    const directory = (await jsonOf(await doFetch(options.directoryUrl))) as unknown as Directory;
    if (directory.newNonce === undefined || directory.newAccount === undefined || directory.newOrder === undefined) {
        throw new Error(`${options.directoryUrl} is not an ACME directory`);
    }

    // Every POST spends a nonce and every response mints the next one, so the pool is a single value passed
    // hand to hand. Seeded from newNonce and refilled from any response that carries a Replay-Nonce.
    let nonce = (await doFetch(directory.newNonce, { method: "HEAD" })).headers.get("replay-nonce") ?? "";
    // oxlint-disable-next-line prefer-const -- read by the signing closure above before the account response assigns it.
    let kid: string | undefined;

    /* One signed request. ACME's JWS is the flattened JSON serialization with the URL bound into the protected
     * header (so a captured request cannot be replayed at a different endpoint) and either `jwk`, before the
     * account exists, or `kid`, its URL, afterwards. Sending both is a protocol error, which is why this is
     * one function rather than two call sites that could drift.
     *
     * `payload: undefined` is POST-as-GET: an empty payload string, which is how RFC 8555 reads a protected
     * resource. It is NOT the same as posting `{}` (that is how a challenge is answered), and confusing the
     * two is the classic way to get a 400 from a correct-looking client. */
    const signedPost = async (url: string, payload: unknown): Promise<Response> => {
        const signer = new FlattenedSign(payload === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(payload)));
        const jws = await signer
            .setProtectedHeader({ alg: "ES256", nonce, url, ...(kid === undefined ? { jwk: publicJwk } : { kid }) })
            .sign(options.accountKey);
        const response = await doFetch(url, {
            method: "POST",
            headers: { "content-type": "application/jose+json" },
            body: JSON.stringify(jws),
        });
        nonce = response.headers.get("replay-nonce") ?? nonce;
        // A consumed/stale nonce is the one failure the CA expects a client to simply retry, once, with the
        // fresh nonce it just handed back, not an error worth failing an issuance over.
        if (response.status === 400 && (await response.clone().text()).includes("badNonce")) {
            return signedPost(url, payload);
        }
        return response;
    };

    // Register (or recover) the account. `onlyReturnExisting` is deliberately NOT set: the CA returns the
    // existing account's URL for a key it already knows, so this is idempotent across restarts.
    const account = await signedPost(directory.newAccount, { termsOfServiceAgreed: true });
    if (!account.ok) {
        throw new Error(`ACME account registration failed: ${await problemOf(account)}`);
    }
    kid = account.headers.get("location") ?? undefined;
    if (kid === undefined) {
        throw new Error("ACME account registration returned no account URL");
    }

    const orderResponse = await signedPost(directory.newOrder, {
        identifiers: options.hostnames.map((value) => ({ type: "dns", value })),
    });
    if (!orderResponse.ok) {
        throw new Error(`ACME order failed: ${await problemOf(orderResponse)}`);
    }
    const orderUrl = orderResponse.headers.get("location") ?? "";
    const order = await jsonOf(orderResponse);
    const authorizations = Array.isArray(order["authorizations"]) ? (order["authorizations"] as string[]) : [];
    const finalizeUrl = typeof order["finalize"] === "string" ? order["finalize"] : undefined;
    if (finalizeUrl === undefined) {
        throw new Error("ACME order carried no finalize URL");
    }

    // Records we published, so the cleanup below runs even when validation fails part-way through.
    const published: string[] = [];
    try {
        for (const authzUrl of authorizations) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- each authorization is published then validated in turn; parallel challenges would race the same zone
            const authz = await jsonOf(await signedPost(authzUrl, undefined));
            const identifier = (authz["identifier"] as { value?: string } | undefined)?.value ?? "";
            const challenges = Array.isArray(authz["challenges"]) ? (authz["challenges"] as Record<string, unknown>[]) : [];
            const dns01 = challenges.find((challenge) => challenge["type"] === "dns-01");
            if (dns01 === undefined || typeof dns01["token"] !== "string" || typeof dns01["url"] !== "string") {
                throw new Error(`the CA offered no dns-01 challenge for ${identifier}`);
            }
            // The key authorization is `<token>.<account key thumbprint>`; DNS-01 publishes its SHA-256,
            // base64url, as the TXT value (RFC 8555 §8.4). NOT the key authorization itself.
            const keyAuthorization = `${dns01["token"]}.${thumbprint}`;
            const recordName = `_acme-challenge.${identifier}`;
            const digest = base64Url(new Uint8Array(createHash("sha256").update(keyAuthorization).digest()));
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await options.publishChallenge(recordName, digest);
            published.push(recordName);
            /* WAIT FOR THE ZONE TO ACTUALLY SERVE IT. A zone API returns once it has accepted the write, which
             * is seconds before its nameservers answer with the record, measured at ~5s on Cloudflare. The CA
             * validates within a second or two of the POST below, so without this it looks into that gap, and
             * `NXDOMAIN looking up TXT` is not a retryable "not yet": the authorization is `invalid` for good. */
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await pollUntil(async () => (await resolveTxt(recordName)).includes(digest), {
                wait,
                now,
                what: `publication of ${recordName}`,
                timeoutMs: PUBLICATION_TIMEOUT_MS,
                intervalMs: PUBLICATION_INTERVAL_MS,
            });
            // Tell the CA to look. `{}` (not POST-as-GET) is what "I am ready" means on a challenge.
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            const accepted = await signedPost(dns01["url"], {});
            if (!accepted.ok) {
                throw new Error(`the CA refused the dns-01 challenge for ${identifier}: ${await problemOf(accepted)}`);
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await pollUntil(
                async () => {
                    const state = await jsonOf(await signedPost(authzUrl, undefined));
                    if (state["status"] === "invalid") {
                        const reason = (state["challenges"] as { error?: { detail?: string } }[] | undefined)?.find((c) => c.error)?.error?.detail;
                        throw new Error(`the CA could not validate ${identifier}${reason === undefined ? "" : `: ${reason}`}`);
                    }
                    return state["status"] === "valid";
                },
                { wait, now, what: `validation of ${identifier}`, timeoutMs: VALIDATION_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
            );
        }

        const finalized = await signedPost(finalizeUrl, { csr: base64Url(buildCsr(options.certificateKey, options.hostnames)) });
        if (!finalized.ok) {
            throw new Error(`ACME finalize failed: ${await problemOf(finalized)}`);
        }
        // Issuance is asynchronous: the order goes `processing` until the certificate URL appears.
        let certificateUrl =
            typeof (await jsonOf(finalized.clone()))["certificate"] === "string" ? String((await jsonOf(finalized))["certificate"]) : undefined;
        if (certificateUrl === undefined) {
            await pollUntil(
                async () => {
                    const state = await jsonOf(await signedPost(orderUrl, undefined));
                    if (state["status"] === "invalid") {
                        throw new Error("the CA marked the order invalid after finalize");
                    }
                    certificateUrl = typeof state["certificate"] === "string" ? state["certificate"] : undefined;
                    return certificateUrl !== undefined;
                },
                { wait, now, what: "certificate issuance", timeoutMs: VALIDATION_TIMEOUT_MS, intervalMs: POLL_INTERVAL_MS },
            );
        }
        const download = await signedPost(certificateUrl!, undefined);
        if (!download.ok) {
            throw new Error(`ACME certificate download failed: ${await problemOf(download)}`);
        }
        // The full chain, leaf first, exactly what a TLS server wants for its `cert`.
        return { certificate: await download.text() };
    } finally {
        // Best-effort by design: a leftover TXT record must never turn a successful issuance into a failure.
        for (const recordName of published) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- cleanup is sequential and off the critical path
            await options.removeChallenge(recordName).catch(() => undefined);
        }
    }
};

// Ask until it is true, or until the deadline. Distinct from a retry loop: the predicate throws on a terminal
// state (the CA said `invalid`), so a definitive no fails immediately rather than waiting out the timeout.
const pollUntil = async (
    predicate: () => Promise<boolean>,
    context: { wait: (ms: number) => Promise<void>; now: () => number; what: string; timeoutMs: number; intervalMs: number },
): Promise<void> => {
    const deadline = context.now() + context.timeoutMs;
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling is sequential by definition
        if (await predicate()) {
            return;
        }
        if (context.now() >= deadline) {
            throw new Error(`timed out waiting for ${context.what}`);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await context.wait(context.intervalMs);
    }
};
