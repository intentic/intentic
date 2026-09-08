import { createHash, type KeyObject } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pollUntil } from "@intentic/base/async";
import { calculateJwkThumbprint, exportJWK, FlattenedSign } from "jose";
import { resolveTxtAuthoritatively } from "./authoritative-dns.js";
import { base64Url, buildCsr } from "./csr.js";

// ACME client (RFC 8555), DNS-01 only: certified names resolve to 127.0.0.1, so there is no public address for HTTP-01;
// the challenge is published via a caller-supplied hook. Uses jose for P1363 JWS signing (node's default DER is
// silently wrong here) and the JWK thumbprint. All network access is injected for in-process testing (acme.test.ts).

// How long to keep polling the CA for validation before giving up, and how often.
const VALIDATION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

// Generous: an early look invalidates the authorization for good and negative-caches the miss.
const PUBLICATION_TIMEOUT_MS = 90_000;
const PUBLICATION_INTERVAL_MS = 2_000;

// Retries for a request that never reached the CA; a slow connection is reliably followed by a fast one.
const TRANSPORT_ATTEMPTS = 3;
const TRANSPORT_RETRY_MS = 2_000;

// Production directory; staging has the same shape but untrusted certs, for testing against real rate limits.
export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

interface Directory {
    readonly newNonce: string;
    readonly newAccount: string;
    readonly newOrder: string;
}

export interface AcmeOptions {
    readonly directoryUrl: string;
    // Identifies the account to the CA; the CA rejects a CSR signed by it instead of the certificate key (§11.1).
    readonly accountKey: KeyObject;
    // Key the certificate attests; never leaves this process, only its public half travels, inside the CSR.
    readonly certificateKey: KeyObject;
    readonly hostnames: readonly string[];
    // Publish/remove `_acme-challenge.<host>` TXT; removal is best-effort and must never fail an issued cert.
    readonly publishChallenge: (recordName: string, value: string) => Promise<void>;
    readonly removeChallenge: (recordName: string) => Promise<void>;
    // Confirms the challenge is live before the CA looks; authoritative by default, injected for tests.
    readonly resolveTxt?: (recordName: string) => Promise<string[]>;
    readonly fetchImpl?: typeof fetch;
    readonly wait?: (ms: number) => Promise<void>;
    // Epoch ms, injected so the validation deadline is testable without a real clock.
    readonly now?: () => number;
}

// Parses a JSON body, or {} when the response carries none (finalize's 200 with just a certificate URL).
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

// The CA's own error text: ACME problem documents are RFC 7807, `detail` the human sentence and `type` the machine tag.
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
    // Retries only a connection that never happened (a rejected fetch); an HTTP error status is the CA answering and
    // must pass through untouched, not be retried into a rate limit.
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
    // RFC 7638: only required members are hashed, so a private JWK thumbprints the same as its public half.
    const thumbprint = await calculateJwkThumbprint(accountJwk, "sha256");
    // Public members only: a `jwk` header carrying `d` would hand the CA our private key.
    const { crv, kty, x, y } = accountJwk;
    if (crv === undefined || kty === undefined || x === undefined || y === undefined) {
        throw new Error("the ACME account key must be an EC key");
    }
    const publicJwk = { crv, kty, x, y };

    const directory = (await jsonOf(await doFetch(options.directoryUrl))) as unknown as Directory;
    if (directory.newNonce === undefined || directory.newAccount === undefined || directory.newOrder === undefined) {
        throw new Error(`${options.directoryUrl} is not an ACME directory`);
    }

    // Nonce is a single value handed forward: seeded from newNonce, refilled by each response's Replay-Nonce.
    let nonce = (await doFetch(directory.newNonce, { method: "HEAD" })).headers.get("replay-nonce") ?? "";
    // oxlint-disable-next-line prefer-const -- read by the signing closure above before the account response assigns it.
    let kid: string | undefined;

    // Flattened JWS with the URL bound into the protected header, and either `jwk` (no account yet) or `kid`, never
    // both. `payload: undefined` is POST-as-GET (an empty body); `{}` is a real answer, e.g. to a challenge.
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
        // A stale nonce is the one failure the CA expects a client to simply retry with the fresh nonce returned.
        if (response.status === 400 && (await response.clone().text()).includes("badNonce")) {
            return signedPost(url, payload);
        }
        return response;
    };

    // `onlyReturnExisting` is deliberately unset, so a known key's registration is idempotent across restarts.
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

    // Records published so far, so cleanup runs even when validation fails partway through.
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
            // Key authorization is `<token>.<thumbprint>`; DNS-01 publishes its digest, not the value itself (§8.4).
            const keyAuthorization = `${dns01["token"]}.${thumbprint}`;
            const recordName = `_acme-challenge.${identifier}`;
            const digest = base64Url(new Uint8Array(createHash("sha256").update(keyAuthorization).digest()));
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await options.publishChallenge(recordName, digest);
            published.push(recordName);
            // Waits for the zone's own nameservers to actually serve the record: a zone API returning success is not
            // the same as being visible, and an early look invalidates the authorization for good.
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await awaitOrThrow(async () => (await resolveTxt(recordName)).includes(digest), {
                wait,
                now,
                what: `publication of ${recordName}`,
                timeoutMs: PUBLICATION_TIMEOUT_MS,
                intervalMs: PUBLICATION_INTERVAL_MS,
            });
            // `{}`, not POST-as-GET, means "ready to be checked" on a challenge.
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            const accepted = await signedPost(dns01["url"], {});
            if (!accepted.ok) {
                throw new Error(`the CA refused the dns-01 challenge for ${identifier}: ${await problemOf(accepted)}`);
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await awaitOrThrow(
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
        // Issuance is asynchronous: the order stays `processing` until the certificate URL appears.
        let certificateUrl =
            typeof (await jsonOf(finalized.clone()))["certificate"] === "string" ? String((await jsonOf(finalized))["certificate"]) : undefined;
        if (certificateUrl === undefined) {
            await awaitOrThrow(
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
        // Full chain, leaf first: exactly what a TLS server's `cert` wants.
        return { certificate: await download.text() };
    } finally {
        // Best-effort: a leftover TXT record must never turn a successful issuance into a failure.
        for (const recordName of published) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- cleanup is sequential and off the critical path
            await options.removeChallenge(recordName).catch(() => undefined);
        }
    }
};

// Polls until true, or throws naming what was waited for. The injected clock lets tests compress a real wait instantly;
// unlike a plain retry loop, the predicate can throw on a terminal state so a definitive no fails immediately.
const awaitOrThrow = async (
    predicate: () => Promise<boolean>,
    context: { wait: (ms: number) => Promise<void>; now: () => number; what: string; timeoutMs: number; intervalMs: number },
): Promise<void> => {
    if (!(await pollUntil(predicate, context))) {
        throw new Error(`timed out waiting for ${context.what}`);
    }
};
