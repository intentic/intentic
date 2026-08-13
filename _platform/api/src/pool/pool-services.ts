import { createHmac, timingSafeEqual } from "node:crypto";
import { ServiceStreamEventSchema, type ServiceStreamEvent } from "@intentic/sandbox-contract";

/* THE SIGNED FORWARD — one metered call from the platform to a service's upstream, carrying proof of origin.
 *
 * The platform is the intermediary the whole services economy rests on: the provider never learns who the
 * user is, the user never holds a provider credential, and what crosses the boundary is exactly the JSON the
 * caller sent. What the provider gets instead of an API key is a signature: `x-intentic-timestamp` plus
 * `x-intentic-signature = HMAC-SHA256(secret, "{timestamp}.{body}")` — the same scheme Stripe signs webhooks
 * with (pool-stripe.ts verifies the mirror image), so a provider verifies with ten lines and a replay dies
 * of old age.
 *
 * WHAT COMES BACK IS A STREAM: a 2xx upstream answer is NDJSON, one event per line in the contract's
 * ServiceStreamEvent vocabulary — `status` lines while the run works, exactly one `result` that ends it.
 * Every line is validated here, at the trust boundary, before it is relayed anywhere: an unparseable line,
 * an unknown event kind, a stream that ends (or blows its size or time budget) before its `result` is a
 * provider that FAILED TO SERVE, which is what refunds. A non-2xx below 500 is still a complete answer the
 * caller pays for reading ("your query was malformed" is the service serving exactly what was asked),
 * relayed verbatim; a 5xx, a timeout or a dead socket refunds, as ever.
 *
 * Injectable fetch, the trial pool's pattern, so the route tests drive streams without a network. */

// How far a forwarded call's timestamp may sit from now before a replayed capture dies of old age.
const SIGNATURE_TOLERANCE_S = 300;

// A streaming run's whole budget, connection to `result`. Streams exist so a run can outlive the old one-
// minute round trip — status lines are what make five otherwise-silent minutes tolerable to watch.
const RUN_DEADLINE_MS = 300_000;

// The most a provider may stream in one run, the request cap ×2 — past it the stream is a misbehaving
// provider, and misbehaving refunds.
const STREAM_CAP_BYTES = 2_000_000;

// A status line is a spinner label, not a log — sliced rather than refused, because truncated prose is not
// a protocol violation.
const STATUS_TEXT_MAX = 400;

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

/* How a forward settled, told apart by what the route must do next:
 *   - `stream`   — the provider is streaming; pull `events` (each already validated) and relay them live.
 *     The generator's RETURN value is the verdict: true iff a `result` arrived, which is what "served" means
 *     for a stream — anything else (early end, bad line, budget blown) refunds.
 *   - `answered` — a complete non-2xx answer below 500, paid and relayed verbatim.
 *   - `failed`   — no answer at all (5xx, timeout, dead socket): refund. */
export type ForwardOutcome =
    | { readonly kind: `stream`; readonly events: AsyncGenerator<ServiceStreamEvent, boolean> }
    | { readonly kind: `answered`; readonly status: number; readonly body: string; readonly contentType: string }
    | { readonly kind: `failed` };

/* One provider stream, read line by line: validate, slice status prose, stop at `result`. Every way a stream
 * can go wrong funnels into `return false` — the one sentence the route needs ("did not serve"). */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ServiceStreamEvent, boolean> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffered = ``;
    let total = 0;
    // One validated line, or `undefined` for a protocol violation. Factored so a mid-stream line and a final
    // unterminated one settle identically.
    const parse = (line: string): ServiceStreamEvent | undefined => {
        try {
            const event = ServiceStreamEventSchema.safeParse(JSON.parse(line));
            if (!event.success) {
                return undefined;
            }
            return event.data.event === `status` ? { event: `status`, text: event.data.text.slice(0, STATUS_TEXT_MAX) } : event.data;
        } catch {
            return undefined;
        }
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                // A final `result` without a trailing newline is still a served run.
                const leftover = buffered.trim();
                if (leftover === ``) {
                    return false;
                }
                const event = parse(leftover);
                if (event === undefined) {
                    return false;
                }
                yield event;
                return event.event === `result`;
            }
            total += value.byteLength;
            if (total > STREAM_CAP_BYTES) {
                await reader.cancel();
                return false;
            }
            buffered += decoder.decode(value, { stream: true });
            let newline = buffered.indexOf(`\n`);
            while (newline !== -1) {
                const line = buffered.slice(0, newline).trim();
                buffered = buffered.slice(newline + 1);
                newline = buffered.indexOf(`\n`);
                if (line === ``) {
                    continue;
                }
                const event = parse(line);
                if (event === undefined) {
                    await reader.cancel();
                    return false;
                }
                yield event;
                if (event.event === `result`) {
                    await reader.cancel();
                    return true;
                }
            }
        }
    } catch {
        // The deadline abort or a socket dying mid-stream lands here: not served.
        return false;
    }
}

export const forwardToService = async (
    upstreamUrl: string,
    secret: string,
    body: string,
    fetchFn: typeof fetch = fetch,
    now: () => Date = () => new Date(),
): Promise<ForwardOutcome> => {
    const timestamp = Math.floor(now().getTime() / 1000);
    const signature = createHmac(`sha256`, secret).update(`${timestamp}.${body}`).digest(`hex`);
    try {
        const response = await fetchFn(upstreamUrl, {
            method: `POST`,
            headers: {
                "content-type": `application/json`,
                accept: `application/x-ndjson`,
                "x-intentic-timestamp": String(timestamp),
                "x-intentic-signature": signature,
            },
            body,
            // One signal covers the whole run: connect, headers, and every read of the stream after them.
            signal: AbortSignal.timeout(RUN_DEADLINE_MS),
        });
        if (response.status >= 500) {
            return { kind: `failed` };
        }
        if (response.status < 200 || response.status >= 300) {
            return {
                kind: `answered`,
                status: response.status,
                body: await response.text(),
                contentType: response.headers.get(`content-type`) ?? `application/json`,
            };
        }
        if (response.body === null) {
            return { kind: `failed` };
        }
        return { kind: `stream`, events: readEvents(response.body) };
    } catch {
        return { kind: `failed` };
    }
};
