import { request } from "node:https";

// Only hosts this daemon may skip certificate verification for (a self-signed dev platform on
// localhost/host.docker.internal); centralized so every caller agrees, and never configurable.
export const isLocalHost = (hostname: string): boolean => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "host.docker.internal";

// 204/304 must carry no body; Response refuses one, and any status below 200 isn't accepted either.
const bodiless = (status: number): boolean => status === 204 || status === 304;

// fetch-shaped wrapper for the one thing undici can't do per-request: skip verification on a self-signed local host.
// Everything else passes through the real fetch untouched.
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
        // Uses the caller's own deadline (each sets an AbortSignal.timeout) rather than inventing a second one.
        init?.signal?.addEventListener(`abort`, () => req.destroy(new Error(`aborted`)));
        if (typeof init?.body === "string") {
            req.write(init.body);
        }
        req.end();
    });
};
