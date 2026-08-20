import { request } from "node:https";

/* THE ONLY HOSTS WHOSE CERTIFICATE THIS DAEMON IS ALLOWED NOT TO VERIFY, in one place because the rule had
 * been written out five times and the fifth one got it wrong by omission.
 *
 * A platform being developed on the owner's own machine arrives as a self-signed cert on localhost or
 * host.docker.internal. Every sandbox→platform caller already makes this exception, announce, the trial
 * poll, the membership gate, the services relay, so a caller that DOESN'T is not stricter, it is simply
 * broken against a dev platform, and it fails in the most confusing way available: the request never
 * completes, the failure is swallowed as "no answer", and the surface above reports the SERVER as faulty.
 * That is exactly what the free-trial card was doing.
 *
 * Nothing off this list is ever exempt, and the list is deliberately not configurable. */
export const isLocalHost = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "host.docker.internal";

// A body Response refuses to carry: 204/304 must be empty, and anything below 200 is not a status it accepts.
const bodiless = (status: number): boolean => status === 204 || status === 304;

/* `fetch`, except that an https URL on one of those hosts may present a self-signed certificate.
 *
 * undici cannot skip verification for a single request, which is the whole reason the callers above drop to
 * node:https by hand, so this wraps that one escape hatch in a fetch-shaped function. Everything else is
 * handed to the real fetch untouched, so a public URL is verified exactly as strictly as before and there is
 * no second HTTP client to keep in step. Reads GET/POST with headers and a string body, which is all any
 * caller here asks of it; the answer is a real Response, so `ok`, `status` and `json()` come for free. */
export const localTolerantFetch: typeof fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.protocol !== "https:" || !isLocalHost(url.hostname)) {
        return fetch(input, init);
    }
    return new Promise<Response>((resolve, reject) => {
        const req = request(
            url,
            {
                method: init?.method ?? "GET",
                headers: (init?.headers ?? {}) as Record<string, string>,
                rejectUnauthorized: false,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("end", () => {
                    const status = response.statusCode ?? 502;
                    resolve(new Response(bodiless(status) ? null : Buffer.concat(chunks), { status: status < 200 ? 502 : status }));
                });
            },
        );
        req.on("error", reject);
        // The caller's own deadline (every one of them sets an AbortSignal.timeout) rather than a second one
        // invented here, so a slow local server is given exactly as long as the caller meant to give it.
        init?.signal?.addEventListener(`abort`, () => req.destroy(new Error(`aborted`)));
        if (typeof init?.body === "string") {
            req.write(init.body);
        }
        req.end();
    });
};
