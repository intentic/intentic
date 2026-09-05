/* WHY THE TRANSLATOR SAID NO, in the one case the harness cannot tell from an outage.
 *
 * A routed turn is the Claude Code loop pointed at the local CLIProxyAPI, which maps the request onto the
 * connected subscription. When the subscription does not cover the model, the upstream refuses with an
 * authentication error and the proxy files that credential as unusable FOR THAT MODEL; every later request is
 * answered `503 auth_unavailable` in about five milliseconds, forever.
 *
 * The harness sees a 5xx and does the right thing for the wrong situation: it rides it out. With the retry
 * watchdog on (harness-credentials.ts) that is eight attempts of backoff, roughly two minutes, and every one of
 * them is a five-millisecond refusal, so the entire wait is sleep. Then the daemon files it as a provider
 * outage and schedules a resume — for a turn that cannot come back. Measured on this sandbox: a Kimi K2.7
 * HighSpeed turn sat for fifty seconds before the user gave up, having produced no frame at all.
 *
 * The classification the SDK hands us throws away the only part that matters. `api_retry` carries a coarse
 * `error` word (`server_error`) and a status; the BODY, which names the plan and the model, never reaches it.
 * So this module goes and asks: one request to the same endpoint, whose answer for a refused model is instant
 * and free, and whose sentence is the vendor's own.
 *
 * ONE PROBE PER TURN, and only once the harness has already reported a retry: on a healthy endpoint this code
 * never runs, and when it does the request it makes is the cheapest one the wire allows. */

// The refusal shapes that will not clear, from CLIProxyAPI's own vocabulary and the upstreams' underneath it.
// A 5xx is otherwise exactly what it looks like — the provider having a bad minute — and must keep riding the
// retry ladder, so this list is deliberately short and every entry names a fact about the CREDENTIAL or the
// MODEL rather than about the moment.
const TERMINAL_REFUSALS = [
    // The proxy has no credential left that will serve this model: it disabled the one it had after the
    // upstream refused it. The sentence that follows carries the upstream's own words.
    "auth_unavailable",
    "no auth available",
    // The upstream's refusal itself, seen on the first call before the proxy files the credential away.
    "authentication_error",
    "authentication_failed",
    // The plan does not include it, in the wording the vendors actually use.
    "does not have access",
    "not have access to",
    "upgrade to higher-tier",
    // The route exists and the model behind it does not, which no retry fixes either.
    "unknown provider for model",
    "model_not_found",
] as const;

/* The sentence to put in front of the user, or undefined when the body describes something a retry might still
 * outlast. Reads the body as TEXT rather than as a shape: it crosses two systems (the proxy wraps the
 * upstream's own error into its own envelope, and the envelope has changed shape across releases), and the one
 * thing every version keeps is the vendor's sentence inside it. */
export const routedRefusal = (body: string): string | undefined => {
    const haystack = body.toLowerCase();
    if (!TERMINAL_REFUSALS.some((marker) => haystack.includes(marker))) {
        return undefined;
    }
    return upstreamSentence(body) ?? body.trim().slice(0, REFUSAL_CHARS);
};

// How much of an unparseable body is worth quoting: enough for the vendor's sentence and its upgrade line,
// short enough that a wall of JSON never becomes the error a user reads.
const REFUSAL_CHARS = 400;

/* The vendor's own sentence, dug out of whatever the proxy wrapped it in. Both layers use the same envelope
 * (`{"type":"error","error":{"message":…}}`), and the inner message is where the readable half lives:
 *
 *   auth_unavailable: no auth available (providers=kimi, model=kimi-k2.7-code-highspeed; last upstream error:
 *   authentication_error: Your current subscription does not have access to kimi-for-coding-highspeed.
 *   Upgrade to higher-tier Kimi Code plans.)
 *
 * What a person needs is the tail, from the upstream's own error onwards; the head is the proxy explaining its
 * bookkeeping. So the message is taken whole when it carries no upstream clause, and from the clause when it
 * does. Undefined when there is no JSON to read, and the caller quotes the body instead. */
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
    const upstream = /last upstream error:\s*(?:[a-z_]+:\s*)?(.+?)\)?\s*$/is.exec(message);
    return (upstream?.[1] ?? message).trim().slice(0, REFUSAL_CHARS);
};

export interface RoutedEndpoint {
    readonly baseUrl: string;
    readonly authToken: string;
    readonly model: string;
}

/* A turn's routed endpoint, or undefined for one that has none. The three fields are set together by
 * harness-credentials (a routed provider is reached through a translator that maps model → upstream, so it has
 * no account default to fall back on), and this is where that "together" is enforced rather than re-asserted at
 * each reader: absent is exactly a native Claude turn, which has nothing to ask. */
export const routedEndpointOf = (credentials: {
    readonly baseUrl?: string;
    readonly authToken?: string;
    readonly model?: string;
}): RoutedEndpoint | undefined =>
    credentials.baseUrl === undefined || credentials.authToken === undefined || credentials.model === undefined
        ? undefined
        : { baseUrl: credentials.baseUrl, authToken: credentials.authToken, model: credentials.model };

/* ASK THE ENDPOINT WHAT IT ACTUALLY SAYS. The smallest legal Messages request there is: one token of output,
 * one word of input, no tools and no system prompt, so a healthy endpoint answers in a second for a fraction
 * of a cent and a refusing one answers instantly for nothing.
 *
 * Non-throwing and undefined-on-doubt, on both counts deliberately: this runs inside a turn that is already
 * failing, and its only power is to END that turn sooner. A network error here, a timeout, a body it cannot
 * read — every one of them means "carry on as before", which is the behaviour that existed before this
 * function did. */
export const probeRoutedEndpoint = async (
    endpoint: RoutedEndpoint,
    options: { readonly fetchFn?: typeof fetch; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
): Promise<string | undefined> => {
    const fetchFn = options.fetchFn ?? fetch;
    // Short, because the answer this is looking for comes back in milliseconds and anything slow enough to
    // reach this deadline is by definition not the instant refusal it is hunting for.
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
