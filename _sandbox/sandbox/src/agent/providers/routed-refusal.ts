// Distinguishes an auth refusal (a subscription that excludes the model, which the proxy then answers instantly and
// forever) from a real outage; the harness sees both as a bare 5xx and retries either way. Reads the response body as
// text, since the SDK's own classification discards it, and probes the endpoint for the vendor's actual sentence.

// Markers for refusals that won't clear on retry; each names the credential or model, not the moment.
const TERMINAL_REFUSALS = [
    // The proxy disabled the only credential that could serve this model; the upstream's words follow.
    "auth_unavailable",
    "no auth available",
    // The upstream's own refusal, seen on the first call before the proxy files the credential away.
    "authentication_error",
    "authentication_failed",
    // The plan doesn't include this model, in the vendors' own wording.
    "does not have access",
    "not have access to",
    "upgrade to higher-tier",
    // The route exists but the model behind it doesn't; no retry fixes that.
    "unknown provider for model",
    "model_not_found",
] as const;

// The sentence to show the user, or undefined if a retry might still outlast this. Reads the body as text, not a fixed
// shape, since the wrapping around the vendor's sentence changes across releases.
export const routedRefusal = (body: string): string | undefined => {
    const haystack = body.toLowerCase();
    if (!TERMINAL_REFUSALS.some((marker) => haystack.includes(marker))) {
        return undefined;
    }
    // The envelope names the credential whatever went wrong, so the cause decides: a stalled dial is this minute's
    // problem, not this plan's.
    if (transientUpstream(body)) {
        return undefined;
    }
    return upstreamSentence(body) ?? body.trim().slice(0, REFUSAL_CHARS);
};

// Causes that clear on their own, in the words the proxy's Go transport and the vendors' gateways use. The proxy files
// the credential away for any of them and then reports "no auth available", which is why the envelope can't be read
// alone. `Service Unavailable` is deliberately absent: it wraps every one of these 503s, terminal ones included.
const TRANSIENT_CAUSES =
    /i\/o timeout|context deadline exceeded|connection (?:refused|reset)|no such host|temporary failure in name resolution|dial (?:tcp|upstream)|\bEOF\b|tls handshake|no capacity available/i;

// True when the failure behind a refusal envelope is transport or capacity, so the credential is worth another call.
// Reads the cause the proxy names, not the envelope around it.
export const transientUpstream = (body: string): boolean => TRANSIENT_CAUSES.test(upstreamCause(body) ?? body);

// Long enough for the vendor's sentence, short enough that a JSON wall never becomes the shown error.
const REFUSAL_CHARS = 400;

// The cause the proxy names after 'last upstream error', minus its own error code and closing paren. Undefined when
// the text names no upstream cause, which is the envelope standing alone.
const upstreamCause = (text: string): string | undefined => /last upstream error:\s*(?:[a-z_]+:\s*)?(.+?)\)?\s*$/is.exec(text)?.[1];

// Extracts the vendor's own sentence from the proxy's error envelope: the tail after 'last upstream error' when
// present, else the whole message. Undefined when there's no JSON to read.
const upstreamSentence = (body: string): string | undefined => {
    let message: string | undefined;
    try {
        const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
        const inner = parsed.error?.message ?? parsed.message;
        message = typeof inner === "string" ? inner : undefined;
    } catch {
        return undefined;
    }
    if (message === undefined) {
        return undefined;
    }
    return (upstreamCause(message) ?? message).trim().slice(0, REFUSAL_CHARS);
};

export interface RoutedEndpoint {
    readonly baseUrl: string;
    readonly authToken: string;
    readonly model: string;
}

// A turn's routed endpoint, or undefined for a native Claude turn, which has nothing to ask. The three fields are set
// together by harness-credentials.
export const routedEndpointOf = (credentials: {
    readonly baseUrl?: string;
    readonly authToken?: string;
    readonly model?: string;
}): RoutedEndpoint | undefined =>
    credentials.baseUrl === undefined || credentials.authToken === undefined || credentials.model === undefined
        ? undefined
        : { baseUrl: credentials.baseUrl, authToken: credentials.authToken, model: credentials.model };

// Smallest legal Messages request: one token out, one word in, no tools. Never throws; any failure to read an answer
// just means carry on as before, since ending the turn sooner is this function's only power.
export const probeRoutedEndpoint = async (
    endpoint: RoutedEndpoint,
    options: { readonly fetchFn?: typeof fetch; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<string | undefined> => {
    const fetchFn = options.fetchFn ?? fetch;
    // Short: the instant refusal this hunts for arrives in milliseconds; anything slower isn't it.
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    try {
        const response = await fetchFn(`${endpoint.baseUrl.replace(/\/$/, "")}/v1/messages`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "anthropic-version": "2023-06-01",
                authorization: `Bearer ${endpoint.authToken}`,
                "x-api-key": endpoint.authToken,
            },
            body: JSON.stringify({ model: endpoint.model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
            signal,
        });
        if (response.ok) {
            return undefined;
        }
        return routedRefusal(await response.text());
    } catch {
        return undefined;
    }
};
