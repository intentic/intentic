import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupAll } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { readCappedBytes } from "@intentic/base/capped-read";
import { webStream } from "@intentic/base/web-stream";

// The only way a sign-in reaches an authorization server. Its addresses come from metadata the MCP server (or whoever
// answers for it) publishes, and the code, the PKCE verifier, a client secret and refresh tokens are posted to them, so
// a hostile server could otherwise aim them at the daemon's own loopback routes or at a service on the owner's network.
// Every hop is checked here, a redirect's included:
// - https, or http to loopback only (RFC 8252 §7.3);
// - while the MCP server itself is on the public internet, every OAuth endpoint must resolve to public addresses only,
//   and the connection is made to an address that passed (the check sits in the socket's own lookup, so a name that
//   answers public to the check and private to the connect, DNS rebinding, is refused at the connect). An MCP server
//   the owner runs on a private address commonly signs in on that network too, so that one is not held to it;
// - redirects are followed by hand, at most five, and a request carrying a credential (a body, an Authorization
//   header) never follows one to another origin;
// - an answer is read to at most 1 MiB, inside one deadline for the whole exchange.

/** Every address a host name resolves to; tests inject their own. */
export type AddressLookup = (hostname: string) => Promise<readonly string[]>;

export type OAuthFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const systemAddressLookup: AddressLookup = async (hostname) => (await dnsLookupAll(hostname, { all: true, verbatim: true })).map((answer) => answer.address);

/** A refusal made here; its message names only an origin, never an address with a query (a code, a state). */
export class OAuthFetchRefused extends Error {
    constructor(
        readonly code: "insecure" | "private-endpoint" | "lookup-failed" | "redirect-origin" | "too-many-redirects" | "too-large" | "timeout",
        readonly origin: string,
    ) {
        super(`OAuth request to ${origin} refused: ${code}`);
    }
}

// Metadata, a registration and a token answer are a few KB; nothing larger is one of them.
const OAUTH_BODY_LIMIT = 1024 * 1024;
const DEADLINE_MS = 20_000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NO_BODY = new Set([101, 204, 205, 304]);

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https, or http to this machine; anything else would put a credential on the wire in the clear. */
const isSecureOAuthEndpoint = (url: URL): boolean => url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_NAMES.has(url.hostname));

// IANA special-purpose ranges (RFC 6890 and its updates) no public service answers from: this host, private networks,
// carrier-grade NAT, link-local (cloud metadata included), documentation, benchmarking, multicast and reserved.
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
] as const) {
    NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

// An IPv4 address carried inside IPv6 (`::ffff:a.b.c.d`, or its hex form), as its IPv4 form.
const mappedIpv4 = (address: string): string | undefined => {
    const match = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(address);
    if (match === null) {
        return undefined;
    }
    if (match[1] !== undefined) {
        return match[1];
    }
    const high = Number.parseInt(match[2] ?? "0", 16);
    const low = Number.parseInt(match[3] ?? "0", 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
};

/** Whether `address` is a public IP address; anything that is not an IP address is not. */
export const isPublicAddress = (address: string): boolean => {
    const bare = address.replace(/^\[(.*)\]$/, "$1").split("%")[0] ?? "";
    const version = isIP(bare);
    if (version === 0) {
        return false;
    }
    const v4 = version === 6 ? mappedIpv4(bare.toLowerCase()) : bare;
    if (v4 !== undefined && isIP(v4) === 4) {
        return !NOT_PUBLIC.check(v4, "ipv4");
    }
    return !NOT_PUBLIC.check(bare, "ipv6");
};

/** The addresses a URL's host stands for: itself when it is an IP address, else what it resolves to. */
const hostAddresses = async (url: URL, resolve: AddressLookup): Promise<readonly string[]> => {
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    return isIP(host) === 0 ? await resolve(host) : [host];
};

// The socket's own name lookup, refusing a name any of whose addresses is not public: what the connection is made to is
// what was checked, whatever the name answered a moment before.
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
        if (error !== null) {
            callback(error, "", 4);
            return;
        }
        if (addresses.length === 0 || !addresses.every((answer) => isPublicAddress(answer.address))) {
            callback(Object.assign(new Error(`${hostname} resolves to an address that is not public`), { code: "EADDRNOTPUBLIC" }), "", 4);
            return;
        }
        if (options.all === true) {
            callback(null, addresses);
            return;
        }
        const [first] = addresses;
        callback(null, first?.address ?? "", first?.family ?? 4);
    });
};

const responseHeaders = (message: IncomingMessage): Headers => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(message.headers)) {
        for (const one of [value ?? []].flat()) {
            headers.append(name, one);
        }
    }
    return headers;
};

// The daemon's own transport for OAuth endpoints: Node's http client, with the lookup above when endpoints must be
// public. Asks for an unencoded answer, so the bytes counted are the bytes read.
const nodeTransport =
    (publicOnly: boolean): OAuthFetch =>
    async (input, init = {}) => {
        const url = new URL(input);
        // The body as bytes, whatever shape the caller handed it in; a form says what it is, as fetch would.
        const body = Buffer.from(await new Response(init.body ?? null).arrayBuffer());
        const headers = new Headers(init.headers);
        if (init.body instanceof URLSearchParams && !headers.has("content-type")) {
            headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
        }
        headers.set("accept-encoding", "identity");
        const options: RequestOptions = { method: init.method ?? "GET", headers: Object.fromEntries(headers) };
        if (init.signal !== undefined && init.signal !== null) {
            options.signal = init.signal;
        }
        if (publicOnly) {
            options.lookup = publicOnlyLookup;
        }
        return await new Promise<Response>((resolve, reject) => {
            const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, (message) => {
                const status = message.statusCode ?? 502;
                if (NO_BODY.has(status)) {
                    message.resume();
                }
                const stream = NO_BODY.has(status) ? null : webStream(Readable.toWeb(message));
                resolve(new Response(stream, { status, statusText: message.statusMessage ?? "", headers: responseHeaders(message) }));
            });
            request.on("error", reject);
            request.end(body.byteLength === 0 ? undefined : body);
        });
    };

export interface SecureOAuthFetchOptions {
    // The MCP server the sign-in is for: while it is public, every OAuth endpoint must be public too.
    readonly resource: string;
    // A transport in place of the daemon's own (a suite's stand-in). The address check still runs before each hop, but
    // only the daemon's own transport re-checks at the connect.
    readonly fetch?: OAuthFetch;
    readonly lookup?: AddressLookup;
    readonly deadlineMs?: number;
}

// The credential a request carries is meant for its own origin only.
const carriesCredential = (request: RequestInit): boolean =>
    (request.body !== undefined && request.body !== null) || new Headers(request.headers).has("authorization");

// `work`, or a rejection with `reason()` once `signal` aborts.
const untilAborted = <T>(work: Promise<T>, signal: AbortSignal, reason: () => Error): Promise<T> => {
    if (signal.aborted) {
        // allow(silent-catch): the caller already has its answer (aborted); the abandoned work's own failure says nothing more
        void work.catch(() => undefined);
        return Promise.reject(reason());
    }
    return new Promise<T>((resolve, reject) => {
        const stop = (): void => reject(reason());
        signal.addEventListener("abort", stop, { once: true });
        void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
    });
};

// The answer with its whole body read, refused past the limit.
const bounded = async (response: Response, origin: string, deadline: AbortSignal): Promise<Response> => {
    let read: Awaited<ReturnType<typeof readCappedBytes>>;
    try {
        read = await readCappedBytes(response, OAUTH_BODY_LIMIT);
    } catch (error) {
        throw deadline.aborted ? new OAuthFetchRefused("timeout", origin) : error;
    }
    if (read.truncated) {
        throw new OAuthFetchRefused("too-large", origin);
    }
    const headers = new Headers(response.headers);
    // The body below is the decoded one, so its encoding and length no longer describe it.
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(NO_BODY.has(response.status) ? null : new Uint8Array(read.bytes), { status: response.status, statusText: response.statusText, headers });
};

const abortReason = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error("the request was aborted"));

// One request on its way: where it goes and what is sent.
interface Hop {
    readonly url: URL;
    readonly request: RequestInit;
}

// Where a redirect answer leads next: the request to send there, or a refusal.
const redirected = (response: Response, location: string, current: URL, request: RequestInit, hop: number): Hop => {
    if (hop >= MAX_REDIRECTS) {
        throw new OAuthFetchRefused("too-many-redirects", current.origin);
    }
    const next = new URL(location, current);
    if (next.origin !== current.origin && carriesCredential(request)) {
        throw new OAuthFetchRefused("redirect-origin", next.origin);
    }
    // RFC 9110 §15.4: 307 and 308 keep the method and body; the others become a bodyless GET.
    if (response.status === 307 || response.status === 308) {
        return { url: next, request };
    }
    const { body: _body, ...rest } = request;
    return { url: next, request: { ...rest, method: "GET" } };
};

/** A fetch for one sign-in's OAuth endpoints, held to the rules at the top of this file. */
export const secureOAuthFetch = (options: SecureOAuthFetchOptions): OAuthFetch => {
    const resolve = options.lookup ?? systemAddressLookup;
    const resource = new URL(options.resource);
    let resourcePublic: Promise<boolean> | undefined;
    const isResourcePublic = (): Promise<boolean> => {
        resourcePublic ??= hostAddresses(resource, resolve).then(
            (addresses) => addresses.length > 0 && addresses.every(isPublicAddress),
            () => {
                throw new OAuthFetchRefused("lookup-failed", resource.origin);
            },
        );
        return resourcePublic;
    };
    // Whether `url` must be reached at public addresses only, refusing it here when it resolves to any other.
    const checkAddress = async (url: URL): Promise<boolean> => {
        if (!(await isResourcePublic())) {
            return false;
        }
        let addresses: readonly string[];
        try {
            addresses = await hostAddresses(url, resolve);
        } catch {
            throw new OAuthFetchRefused("lookup-failed", url.origin);
        }
        if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
            throw new OAuthFetchRefused("private-endpoint", url.origin);
        }
        return true;
    };
    // One hop: the answer, after its address and scheme pass.
    const hop = async (url: URL, request: RequestInit, signal: AbortSignal, deadline: AbortSignal): Promise<Response> => {
        if (!isSecureOAuthEndpoint(url)) {
            throw new OAuthFetchRefused("insecure", url.origin);
        }
        const timedOut = (): Error => (deadline.aborted ? new OAuthFetchRefused("timeout", url.origin) : abortReason(signal));
        // A lookup that never answers is bounded like the request it guards.
        const publicOnly = await untilAborted(checkAddress(url), signal, timedOut);
        const send = options.fetch ?? nodeTransport(publicOnly);
        try {
            return await send(url, { ...request, redirect: "manual", signal });
        } catch (error) {
            throw deadline.aborted ? new OAuthFetchRefused("timeout", url.origin) : error;
        }
    };
    return async (input, init = {}) => {
        const deadline = AbortSignal.timeout(options.deadlineMs ?? DEADLINE_MS);
        const signal = init.signal === undefined || init.signal === null ? deadline : AbortSignal.any([deadline, init.signal]);
        let next: Hop = { url: new URL(input), request: { ...init } };
        for (let count = 0; ; count += 1) {
            const response = await hop(next.url, next.request, signal, deadline);
            const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
            if (location === null && response.type !== "opaqueredirect" && response.status !== 0) {
                return await bounded(response, next.url.origin, deadline);
            }
            // allow(silent-catch): a redirect's own body is never read; a cancel that fails has nothing left to stop
            await response.body?.cancel().catch(() => undefined);
            if (location === null) {
                // A redirect whose target the transport hides cannot be checked, so it is not followed.
                throw new OAuthFetchRefused("redirect-origin", next.url.origin);
            }
            next = redirected(response, location, next.url, next.request, count);
        }
    };
};
