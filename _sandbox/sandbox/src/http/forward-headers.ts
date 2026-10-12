// The headers a proxying route passes on, for every door that relays a request or its answer: the privacy gateway, the
// MCP door, the credential broker, extension backends, the runner's translator. Hop-by-hop headers describe the
// connection they arrived on, never the request, so none of them is forwarded (RFC 9110 §7.6.1), and nor is any header
// the sender's `Connection` names as hop-by-hop. Each door used to keep its own list, and the lists had drifted: some
// forwarded `proxy-authorization`, `te` and `trailer`, and only one read `Connection`.

const HOP_BY_HOP: readonly string[] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

// What a request relayed through `fetch` must also leave behind: the host it was addressed to, the length of a body
// fetch frames again, and the encodings the caller accepts, so the answer arrives as plain bytes the door can read.
export const REQUEST_REFRAMED: readonly string[] = ["host", "content-length", "accept-encoding"];

// What an answer relayed from `fetch` must also leave behind: fetch has already decoded the body, so its original
// encoding and length no longer describe the bytes being passed on.
export const RESPONSE_REFRAMED: readonly string[] = ["content-encoding", "content-length"];

/**
 * A copy of `from` without hop-by-hop headers, without any header its `Connection` lists, and without `drop` (names in
 * any case). Values are copied as they are, repeated headers such as `set-cookie` included.
 */
export const forwardHeaders = (from: Headers, drop: Iterable<string> = []): Headers => {
    const headers = new Headers(from);
    for (const token of from.get("connection")?.split(",") ?? []) {
        const name = token.trim();
        if (name !== "") {
            headers.delete(name);
        }
    }
    for (const name of [...HOP_BY_HOP, ...drop]) {
        headers.delete(name);
    }
    return headers;
};
