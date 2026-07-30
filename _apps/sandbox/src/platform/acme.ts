import { createHash, type KeyObject } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { calculateJwkThumbprint, exportJWK, FlattenedSign } from "jose";
import { base64Url, buildCsr } from "./csr.js";

/* An ACME client (RFC 8555), DNS-01 only, no dependencies beyond `jose` — which the daemon already carries for
 * verifying Google ID tokens, and which supplies the two things worth not re-deriving: JWS signing in the
 * P1363 form JOSE requires (node's default is DER, which is the same length and silently wrong here) and the
 * JWK thumbprint the key authorization is built from.
 *
 * DNS-01 rather than HTTP-01 because the name being certified — local-<id>.<zone> — resolves to 127.0.0.1.
 * There is no address on the public internet for a CA to reach, so proving control has to happen in the zone,
 * which is why the challenge is published through a caller-supplied hook: the sandbox holds no token for the
 * zone on the intentic path and relays to the platform, while nothing here needs to know which it is.
 *
 * Everything that talks to the network is injected (`fetchImpl`, the publish/remove hooks, `wait`), so the
 * whole order flow is exercised in-process against a fake CA — see acme.test.ts. */

// How long to keep asking whether the CA has validated the challenge before giving up. Generous: it polls
// authoritative DNS, and a record published seconds ago may take a moment to be visible to it.
const VALIDATION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

// Let's Encrypt's production directory. The staging directory is the same shape and is what a first real run
// should point at — its certificates are untrusted, but its rate limits are the ones you want to hit.
export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

interface Directory {
    readonly newNonce: string;
    readonly newAccount: string;
    readonly newOrder: string;
}

export interface AcmeOptions {
    readonly directoryUrl: string;
    // The ACME ACCOUNT key — identifies us to the CA across orders and renewals. Distinct from the
    // certificate key: the CA rejects a CSR signed by the account key (RFC 8555 §11.1).
    readonly accountKey: KeyObject;
    // The key the certificate will attest. Never leaves this process — only its public half, inside the CSR.
    readonly certificateKey: KeyObject;
    readonly hostnames: readonly string[];
    // Publish `_acme-challenge.<host>` TXT = `value`, and remove it afterwards. Removal is best-effort: a
    // stale challenge record is untidy, not dangerous, and must never fail an otherwise-issued certificate.
    readonly publishChallenge: (recordName: string, value: string) => Promise<void>;
    readonly removeChallenge: (recordName: string) => Promise<void>;
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
    const doFetch = options.fetchImpl ?? fetch;
    const wait = options.wait ?? ((ms: number) => sleep(ms));
    const now = options.now ?? (() => Date.now());
    const accountJwk = await exportJWK(options.accountKey);
    // The thumbprint is RFC 7638: only the required members are hashed, so passing the private JWK yields the
    // same value as the public one — and the key authorization below must match what the CA recomputes.
    const thumbprint = await calculateJwkThumbprint(accountJwk, "sha256");
    // The public half only — a JWS `jwk` header carrying `d` would hand the CA our private key. Every member
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
    let kid: string | undefined;

    /* One signed request. ACME's JWS is the flattened JSON serialization with the URL bound into the protected
     * header (so a captured request cannot be replayed at a different endpoint) and either `jwk` — before the
     * account exists — or `kid`, its URL, afterwards. Sending both is a protocol error, which is why this is
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
        // fresh nonce it just handed back — not an error worth failing an issuance over.
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
            // base64url, as the TXT value (RFC 8555 §8.4) — NOT the key authorization itself.
            const keyAuthorization = `${dns01["token"]}.${thumbprint}`;
            const recordName = `_acme-challenge.${identifier}`;
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await options.publishChallenge(recordName, base64Url(new Uint8Array(createHash("sha256").update(keyAuthorization).digest())));
            published.push(recordName);
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
                { wait, now, what: `validation of ${identifier}` },
            );
        }

        const finalized = await signedPost(finalizeUrl, { csr: base64Url(buildCsr(options.certificateKey, options.hostnames)) });
        if (!finalized.ok) {
            throw new Error(`ACME finalize failed: ${await problemOf(finalized)}`);
        }
        // Issuance is asynchronous: the order goes `processing` until the certificate URL appears.
        let certificateUrl = typeof (await jsonOf(finalized.clone()))["certificate"] === "string" ? String((await jsonOf(finalized))["certificate"]) : undefined;
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
                { wait, now, what: "certificate issuance" },
            );
        }
        const download = await signedPost(certificateUrl!, undefined);
        if (!download.ok) {
            throw new Error(`ACME certificate download failed: ${await problemOf(download)}`);
        }
        // The full chain, leaf first — exactly what a TLS server wants for its `cert`.
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
    context: { wait: (ms: number) => Promise<void>; now: () => number; what: string },
): Promise<void> => {
    const deadline = context.now() + VALIDATION_TIMEOUT_MS;
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- polling is sequential by definition
        if (await predicate()) {
            return;
        }
        if (context.now() >= deadline) {
            throw new Error(`timed out waiting for ${context.what}`);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
        await context.wait(POLL_INTERVAL_MS);
    }
};
