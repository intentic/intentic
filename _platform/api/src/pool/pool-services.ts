import { createHmac, timingSafeEqual } from "node:crypto";

/* THE SIGNED FORWARD — one metered call from the platform to a service's upstream, carrying proof of origin.
 *
 * The platform is the intermediary the whole services economy rests on: the provider never learns who the
 * user is, the user never holds a provider credential, and what crosses the boundary is exactly the JSON the
 * caller sent. What the provider gets instead of an API key is a signature: `x-intentic-timestamp` plus
 * `x-intentic-signature = HMAC-SHA256(secret, "{timestamp}.{body}")` — the same scheme Stripe signs webhooks
 * with (pool-stripe.ts verifies the mirror image), so a provider verifies with ten lines and a replay dies
 * of old age. JSON in, JSON out, one minute, no streaming: v1's stated shape, sized for research-and-answer
 * services rather than live feeds.
 *
 * Injectable fetch, the trial pool's pattern, so the route tests drive failures without a network. */

// How far a forwarded call's timestamp may sit from now before a replayed capture dies of old age.
const SIGNATURE_TOLERANCE_S = 300;

/* The provider's side of the handshake, published here as working reference: recompute
 * HMAC-SHA256(secret, "{timestamp}.{body}") and compare constant-time. The platform's own demo upstream
 * verifies with exactly this, so the reference can never drift from what the forward actually sends. */
export const verifyServiceSignature = (
    body: string,
    timestamp: string | undefined,
    signature: string | undefined,
    secret: string,
    now: () => Date = () => new Date(),
): boolean => {
    const at = Number(timestamp);
    if (timestamp === undefined || signature === undefined || !Number.isFinite(at) || Math.abs(now().getTime() / 1000 - at) > SIGNATURE_TOLERANCE_S) {
        return false;
    }
    const expected = createHmac(`sha256`, secret).update(`${timestamp}.${body}`).digest(`hex`);
    const a = Buffer.from(signature, `utf8`);
    const b = Buffer.from(expected, `utf8`);
    return a.length === b.length && timingSafeEqual(a, b);
};

export interface ForwardResult {
    // Whether the provider ANSWERED — any completed HTTP exchange below 500. A 4xx is the provider refusing
    // this particular request, which is an answer the caller should see and pay for reading; a 5xx, a
    // timeout or a dead socket is a service that failed to serve, which is what refunds.
    readonly served: boolean;
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
}

export const forwardToService = async (
    upstreamUrl: string,
    secret: string,
    body: string,
    fetchFn: typeof fetch = fetch,
    now: () => Date = () => new Date(),
): Promise<ForwardResult> => {
    const timestamp = Math.floor(now().getTime() / 1000);
    const signature = createHmac(`sha256`, secret).update(`${timestamp}.${body}`).digest(`hex`);
    try {
        const response = await fetchFn(upstreamUrl, {
            method: `POST`,
            headers: {
                "content-type": `application/json`,
                "x-intentic-timestamp": String(timestamp),
                "x-intentic-signature": signature,
            },
            body,
            signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        return {
            served: response.status < 500,
            status: response.status,
            body: text,
            contentType: response.headers.get(`content-type`) ?? `application/json`,
        };
    } catch {
        return { served: false, status: 0, body: ``, contentType: `application/json` };
    }
};
