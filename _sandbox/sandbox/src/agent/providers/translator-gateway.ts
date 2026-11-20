import type { Context } from "hono";
import type { Logger } from "pino";
import { answerCovers } from "@intentic/sandbox-contract/models/plan-pools";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { join } from "node:path";
import type { KeyedProvider } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { parseJsonOr } from "@intentic/base/json";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { CompositionCore } from "../../composition.js";
import { tokenEquals } from "../../auth/token-equals.js";
import { readableProviderText } from "../../engines/provider-error-text.js";
import { REQUEST_REFRAMED, RESPONSE_REFRAMED, forwardHeaders } from "../../http/forward-headers.js";
import { TRANSLATOR_GATEWAY_PATH } from "../../http/translator-gateway-url.js";
import { defineSlice } from "../../seams/slice.js";
import type { ProviderRefusalStore } from "../../usage/provider-refusals.js";
import { namedReset } from "../../usage/reset-sentences.js";
import type { ServiceabilityDeps } from "../../usage/serviceability/serviceability.js";
import { opt } from "../../opt.js";
import { saysSpent } from "../run/frames/limits/limit-cause.js";
import { pinOrder } from "./accounts/placement.js";
import { usageKey } from "./translator.js";
import { logPins, PINNED_MODEL_ID } from "./translator-prefixes.js";
import { type TranslatorGatewaySessions, translatorGatewaySessions } from "./translator-gateway-session.js";

/* THE DAEMON PLACES EVERY ROUTED REQUEST ON ONE ACCOUNT, so every refusal names the account that gave it.
   A routed loop (Gemini on OpenCode, Codex, the Claude Code harness on a routed model) used to send its requests straight
   to the translator, which chose the credential itself: round robin, retrying a refused request on at most five of the
   provider's credentials (translator.ts MAX_RETRY_CREDENTIALS). On 2026-11-08 a Gemini send on a sandbox holding 31
   Google accounts was tried on 5 of them, none the one with room, and refused; the daemon heard only the last refusal,
   could not say whose it was, and filed it under no account, so the verdict over all 31 accounts flip-flopped with every
   reading that came in after it.

   Every routed loop now sends here instead (`ALL /translator-gateway/<session>/*`, translator-gateway.routes.ts), with
   the translator's own bearer, and the request goes on to the translator with its headers as they came. The session is
   an address signed for one provider under the gateway's own key (translator-gateway-session.ts): this door sits on the
   daemon's HTTP server, which the sandbox's public address reaches, and the bearer is a constant every image bakes in,
   so an unsigned address is answered as no address at all, before the bearer is even read. One whose JSON body names a
   model is placed by the sandbox's one placement (accounts/placement.ts pinOrder): the provider's accounts that can
   serve that model, best first, then a spent one or two as probes, each asked for by its own prefix (`<prefix>/<model>`,
   translator-prefixes.ts), which the translator serves on that credential alone. A spent allowance comes back from a
   known account: it is filed under that account with the provider's own words and reset, the account is re-read, and
   the next one is tried, each at most once per request. An answer streams through untouched and, once it has come
   whole, settles what that account had refused of the model before the request went out. When every account refused,
   the loop gets the last refusal as it came. A request naming no model, or one with no account to pin, goes through
   unpinned, as it always did. */

// How much of a refusal's sentence is filed: enough for any provider's, short enough to stay readable in the ledger.
const MESSAGE_CHARS = 400;

// How long a round of giving credentials their prefixes stands before a request asks for another: one signed in since is
// pinned by the next request after it rather than only when someone opens the accounts list.
const PIN_MAX_AGE_MS = 10 * 60_000;

// Where the gateway's signing key is kept, under the auth root beside the privacy gateway's (privacy-gateway.key).
const SESSION_KEY_FILE = "translator-gateway.key";

/** One account a request may be pinned to: its auth file's name and the prefix the translator knows it by. */
export interface PinCandidate {
    readonly account: string;
    readonly prefix: string;
}

export interface TranslatorGateway {
    // `ALL /translator-gateway/{session}/*`.
    readonly route: (c: Context<AppEnv>) => Promise<Response>;
    // Where a routed loop sends one provider's model requests: this gateway on the daemon's loopback address, under a
    // session signed for that provider. Read where the loop is configured, never kept past a key the daemon still holds.
    readonly baseUrlFor: (provider: KeyedProvider) => Promise<string>;
    // When this gateway last filed a refusal naming its account for one provider's model, in ms; undefined when it has
    // filed none since the daemon started. What a turn's own failure is read against (failure-queries.ts).
    readonly attributedAt: (provider: string, model: string) => number | undefined;
    // When it last handed a loop a throttle on one provider's model (`throttled`, causeOf), in ms; undefined when none
    // since the daemon started. What tells a turn refused on a 429 that no account's allowance was in question.
    readonly throttledAt: (provider: string, model: string) => number | undefined;
}

export interface TranslatorGatewayDeps {
    readonly translator: { readonly url: string; readonly token: string };
    // The daemon's own loopback address, which every address this mints starts with.
    readonly loopbackBase: string;
    readonly sessions: TranslatorGatewaySessions;
    // The accounts a request for this model may be pinned to, best first; empty sends it unpinned.
    readonly candidates: (provider: KeyedProvider, model: string) => Promise<readonly PinCandidate[]>;
    readonly refusals: Pick<ProviderRefusalStore, "record" | "settle">;
    // The other models an answer on `model` proves open on this account (plan-pools.ts answerCovers, read on its own
    // reading): Codex meters every model from one allowance, so an answer on one settles a refusal of another. None
    // given, an answer settles its own model alone.
    readonly covers?: ((provider: KeyedProvider, account: string, model: string) => Promise<(other: string) => boolean>) | undefined;
    // Re-measures one account that just refused, while its refusal is the freshest thing known about it.
    readonly reread: (provider: KeyedProvider, account: string) => void;
    // Re-reads the models one account runs: the translator turned a request for a model away from it (`unroutable`), so
    // the list its row carries, which keeps it out of that model's candidates, may be out of date.
    readonly unrouted?: ((provider: KeyedProvider, account: string) => void) | undefined;
    // The provider said this account's plan does not include the model, which the translator listed for it (`offPlan`):
    // the model leaves that account's list (translator-models.ts), so it is not placed there again.
    readonly offPlan?: ((provider: KeyedProvider, account: string, model: string) => void) | undefined;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
}

/**
 * The accounts of a routed provider a request for `model` may be pinned to, in the order they are asked (placement.ts
 * pinOrder: those that can serve it best first, then a spent one or two as probes), each with the prefix the translator
 * knows it by; one it knows by none is left out.
 */
export const pinnedCandidates = async (deps: ServiceabilityDeps, provider: KeyedProvider, model: string): Promise<readonly PinCandidate[]> =>
    (await pinOrder(deps, provider, model, (account) => deps.cliProxy.accountPrefix(account) !== undefined)).flatMap((account) => {
        const prefix = deps.cliProxy.accountPrefix(account);
        return prefix === undefined ? [] : [{ account, prefix }];
    });

// The token a request presents, in any of the places the translator itself reads one from.
const presented = (headers: Headers): string => {
    const authorization = headers.get("authorization") ?? "";
    return authorization.startsWith("Bearer ") ? authorization.slice(7) : (headers.get("x-api-key") ?? headers.get("x-goog-api-key") ?? "");
};

const isJson = (type: string | null): boolean => type !== null && /^application\/([\w.+-]*\+)?json\b/iu.test(type);

// What follows the session in the path, query included: what the translator is asked for.
const restOf = (c: Context<AppEnv>, session: string): string => {
    const url = new URL(c.req.url);
    const prefix = `${TRANSLATOR_GATEWAY_PATH}/${session}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    return `${path === "" ? "/" : path}${url.search}`;
};

// A request body that can be pinned: a JSON object naming a model by a string the gateway has not pinned already. Every
// other field is carried as it came.
const PinnableBodySchema = z.looseObject({ model: z.string().min(1) });
type PinnableBody = z.infer<typeof PinnableBodySchema>;

interface Pinnable {
    readonly provider: KeyedProvider;
    readonly model: string;
    readonly body: PinnableBody;
}

const pinnableOf = (provider: KeyedProvider, contentType: string | null, raw: Uint8Array<ArrayBuffer> | undefined): Pinnable | undefined => {
    if (raw === undefined || raw.byteLength === 0 || !isJson(contentType)) {
        return undefined;
    }
    // A body this cannot read is the translator's to refuse, sent exactly as it came.
    const body = PinnableBodySchema.safeParse(parseJsonOr(new TextDecoder().decode(raw), undefined));
    return !body.success || PINNED_MODEL_ID.test(body.data.model) ? undefined : { provider, model: body.data.model, body: body.data };
};

// The same request with its model asked for on one account.
const pinnedBody = (asked: Pinnable, prefix: string): Uint8Array<ArrayBuffer> =>
    new TextEncoder().encode(JSON.stringify({ ...asked.body, model: `${prefix}/${asked.model}` }));

// A refusal read whole before anything of it reached the loop, kept so it can be handed on exactly as it came.
interface ReadRefusal {
    readonly status: number;
    readonly statusText: string;
    readonly headers: Headers;
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly text: string;
}

const readRefusal = async (response: Response): Promise<ReadRefusal> => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
        status: response.status,
        statusText: response.statusText,
        headers: forwardHeaders(response.headers, RESPONSE_REFRAMED),
        bytes,
        text: new TextDecoder().decode(bytes),
    };
};

const handedOn = (refusal: ReadRefusal): Response =>
    new Response(refusal.bytes, { status: refusal.status, statusText: refusal.statusText, headers: refusal.headers });

/* A 429 IS NOT A SPENT ALLOWANCE UNTIL THE PROVIDER SAYS SO. Google answers RESOURCE_EXHAUSTED for both: "Individual
   quota reached … Resets in 163h13m58s" when an account's allowance is spent, and the bare "Resource has been exhausted
   (e.g. check quota)." when it is slowing requests down. Every 429 used to be filed as the first, so on 2026-11-14 a
   throttle on Gemini 3.8 Flash was filed against each of 31 accounts in turn, each was re-read, each reading showed most
   of its Gemini pool left and answered the refusal, and the loop's next retry did it all again: about four hundred
   ready → spent → ready flips in an afternoon, Google's row dropping out of the chat's "Usage left" and coming back with
   them, and 31 requests to Google per request the loop made, each throttled in turn. So a refusal is read for what it is:
   - `spent`: the provider's words say the allowance is spent, or it names a reset further out than a retry
     (RETRY_HORIZON_S). Filed under the account that gave it, which is re-read, and the next account is asked.
   - `benched`: the translator's own answer for a credential it is resting on this model (`model_cooldown`). Nothing
     reached the provider, and the bench is on the translator's listing of the account already (modelCooldowns): the
     next account is asked, nothing filed.
   - `throttled`: any other 429, or RESOURCE_EXHAUSTED under another status. No allowance is in question, so nothing is
     filed and nothing re-read; another account may not be throttled, so a few are asked (THROTTLED_ASKS), and then the
     loop gets the throttle as it came, to retry on its own backoff. A turn that ends on it is an outage, not a spent
     allowance (limit-cause.ts throttleAsOutage, which reads throttledAt). */
type RefusalCause = "spent" | "benched" | "throttled";

// How many accounts a throttled request is tried on before the loop gets the throttle back. Model capacity throttles every
// account alike, and asking all 31 at once only adds 31 requests to what is being throttled.
const THROTTLED_ASKS = 3;

// The translator's own word for a credential it is resting (CLIProxyAPI's `model_cooldown` error code).
const TRANSLATOR_BENCH = /"model_cooldown"/u;

const causeOf = (refusal: ReadRefusal, now: number): RefusalCause | undefined => {
    if (refusal.status < 400) {
        return undefined;
    }
    if (refusal.status === 429 && TRANSLATOR_BENCH.test(refusal.text)) {
        return "benched";
    }
    // The words every runtime's rate limit is read by (limit-cause.ts): an allowance's, or a reset past a retry's.
    if (saysSpent(refusal.text, now)) {
        return "spent";
    }
    return refusal.status === 429 || /RESOURCE_EXHAUSTED/u.test(refusal.text) ? "throttled" : undefined;
};

// The translator does not route this prefixed model to that credential: the plan does not cover the model, or the
// translator has not registered the prefix yet. Not the account's refusal; the next one is asked.
const unroutable = (refusal: ReadRefusal, prefix: string): boolean =>
    refusal.status === 400 && refusal.text.includes("model_not_found") && refusal.text.includes(`${prefix}/`);

/* The provider's own word that this account's plan does not include the model, on a request the translator routed to it
   because its table says the plan does: ChatGPT's 400 `model_not_found` ("The 'gpt-6.1-terra' model is not supported when
   using Codex with a ChatGPT account.", for both Free sign-ins on 2026-11-20), or the translator's 503 `auth_unavailable`
   relaying it as the last upstream error once it has rested the credential on that model. Not the account's allowance,
   so nothing is filed against it; the next account is asked, since another plan may include the model. Read after
   `unroutable`, which is the translator's own 400 naming the prefix. */
const offPlan = (refusal: ReadRefusal): boolean => (refusal.status === 400 || refusal.status === 503) && refusal.text.includes("model_not_found");

// Shaped like each wire's own error, so the loop shows the sentence instead of a parse failure.
const failure = (status: number, type: string, message: string): Response => Response.json({ type: "error", error: { type, message } }, { status });

// An answer streamed through as it came; once it has come whole, `settle` runs.
const answered = (response: Response, settle: () => void): Response => {
    const init = { status: response.status, statusText: response.statusText, headers: forwardHeaders(response.headers, RESPONSE_REFRAMED) };
    if (response.body === null) {
        settle();
        return new Response(null, init);
    }
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: settle })), init);
};

// One request on its way to the translator, as the loop sent it.
interface Outgoing {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly raw: Uint8Array<ArrayBuffer> | undefined;
    readonly signal: AbortSignal;
}

const outgoingOf = async (c: Context<AppEnv>, translatorUrl: string, session: string): Promise<Outgoing> => {
    const headers = forwardHeaders(c.req.raw.headers, REQUEST_REFRAMED);
    headers.set("accept-encoding", "identity");
    return {
        url: `${translatorUrl.replace(/\/$/u, "")}${restOf(c, session)}`,
        method: c.req.method,
        headers,
        raw: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : new Uint8Array(await c.req.arrayBuffer()),
        signal: c.req.raw.signal,
    };
};

// The gateway's deps with its defaults filled, and what it remembers: when it last filed a refusal for each model, and
// when it last handed a loop a throttle on it.
interface Gateway extends TranslatorGatewayDeps {
    readonly send: typeof fetch;
    readonly clock: () => number;
    readonly attributed: Map<string, number>;
    readonly throttled: Map<string, number>;
}

// The line a filed refusal leaves in the log.
interface RefusalLine {
    readonly provider: string;
    readonly account: string;
    readonly model: string;
    readonly status: number;
    resetsAt?: string;
}

// A spent allowance filed under the account that gave it, with the provider's own reset, and that account re-read.
const fileRefusal = async (g: Gateway, asked: Pinnable, candidate: PinCandidate, refusal: ReadRefusal): Promise<void> => {
    const at = g.clock();
    const message = readableProviderText(refusal.text).slice(0, MESSAGE_CHARS);
    const resetsAt = namedReset(message, at) ?? namedReset(refusal.text, at);
    const filed: ProviderRefusal = { at, kind: "limit", message, account: candidate.account, model: asked.model };
    const line: RefusalLine = { provider: asked.provider, account: candidate.account, model: asked.model, status: refusal.status };
    if (resetsAt !== undefined) {
        filed.resetsAt = resetsAt;
        line.resetsAt = new Date(resetsAt * 1000).toISOString();
    }
    try {
        await g.refusals.record(asked.provider, filed);
        g.attributed.set(`${asked.provider}:${asked.model}`, at);
    } catch (error) {
        g.logger.warn({ err: error, provider: asked.provider, account: candidate.account }, "translator gateway: a refusal could not be filed");
    }
    g.reread(asked.provider, candidate.account);
    g.logger.warn(line, "translator gateway: an account refused the request, trying the next");
};

// The other models an answer on this account proves open, where the gateway can read that. A reading that cannot be read
// costs the answer only the other models it would have covered, and the line says so.
const coveredBy = async (g: Gateway, asked: Pinnable, account: string): Promise<((other: string) => boolean) | undefined> =>
    g.covers?.(asked.provider, account, asked.model).catch((error: Error) => {
        g.logger.warn({ err: error, provider: asked.provider, account }, "translator gateway: the reading an answer covers other models by could not be read");
        return undefined;
    });

// What an answer on one account proves, once it has come whole: what that account had refused of the model before the
// request went out is over, and of every model the answer covers (a forced send on a cheaper Codex model is how a person
// finds the allowance back, while the composer goes on judging the model they were refused on). Nothing is proved by an
// answer the loop walked away from.
const settleOn = (g: Gateway, asked: Pinnable, candidate: PinCandidate, askedAt: number, signal: AbortSignal) => (): void => {
    if (signal.aborted) {
        return;
    }
    void coveredBy(g, asked, candidate.account)
        .then((covers) => g.refusals.settle(asked.provider, { account: candidate.account, model: asked.model, askedAt, ...opt("covers", covers) }))
        .catch((error: Error) => g.logger.warn({ err: error, provider: asked.provider, account: candidate.account }, "translator gateway: an answer could not settle"));
};

// A throttle handed back to the loop, remembered for the turn that may end on it (throttledAt).
const handedThrottle = (g: Gateway, asked: Pinnable, refusal: ReadRefusal, tried: number): Response => {
    g.throttled.set(`${asked.provider}:${asked.model}`, g.clock());
    g.logger.info(
        { provider: asked.provider, model: asked.model, status: refusal.status, accounts: tried },
        "translator gateway: the provider is throttling this model, not refusing an allowance; the loop retries on its own backoff",
    );
    return handedOn(refusal);
};

// What one request's round of asking has met so far, account by account.
interface Round {
    last?: { readonly refusal: ReadRefusal; readonly cause: RefusalCause };
    throttles: number;
    readonly benched: string[];
    readonly unrouted: string[];
    readonly offPlanned: string[];
    lastOffPlan?: ReadRefusal;
}

// The line a request no account would take leaves: which accounts the translator is resting, which do not run the model,
// and which the provider said do not have it on their plan. All are skipped without a word of their own, so without it a
// turn refused that way named nobody (2026-11-19).
const nobodyTook = (g: Gateway, asked: Pinnable, round: Round): void => {
    g.logger.info(
        { provider: asked.provider, model: asked.model, benched: round.benched, unrouted: round.unrouted, offPlan: round.offPlanned },
        "translator gateway: no account would take the request (benched: the translator is resting it; unrouted: it does not run this model; offPlan: the provider said its plan does not include it)",
    );
};

// A refusal that says nothing of the account's allowance: the translator does not route the model to it, or the provider
// said its plan lacks the model, which then leaves that account's list. Noted, and the next account is asked.
const passedOver = (g: Gateway, asked: Pinnable, candidate: PinCandidate, refusal: ReadRefusal, round: Round): boolean => {
    if (unroutable(refusal, candidate.prefix)) {
        round.unrouted.push(candidate.account);
        g.unrouted?.(asked.provider, candidate.account);
        return true;
    }
    if (!offPlan(refusal)) {
        return false;
    }
    round.offPlanned.push(candidate.account);
    round.lastOffPlan = refusal;
    g.offPlan?.(asked.provider, candidate.account, asked.model);
    g.logger.warn(
        { provider: asked.provider, account: candidate.account, model: asked.model, status: refusal.status },
        "translator gateway: the provider said this account's plan does not include the model, trying the next",
    );
    return true;
};

// What the loop gets once every account was asked and none answered: the last refusal as it came (a throttle as one);
// where every account that answered said its plan lacks the model, the provider's own words; where none routed the
// prefix at all, undefined, and the caller sends unpinned.
const roundEnd = (g: Gateway, asked: Pinnable, round: Round): Response | undefined => {
    const { last, lastOffPlan } = round;
    if (last === undefined) {
        if (round.unrouted.length > 0 || lastOffPlan !== undefined) {
            nobodyTook(g, asked, round);
        }
        return lastOffPlan === undefined ? undefined : handedOn(lastOffPlan);
    }
    if (last.cause === "benched") {
        nobodyTook(g, asked, round);
    }
    return last.cause === "throttled" ? handedThrottle(g, asked, last.refusal, round.throttles) : handedOn(last.refusal);
};

// Asks each candidate in turn, at most once, until one answers or refuses for something other than a spent allowance, a
// translator's bench, a throttle (causeOf) or a plan that lacks the model. Past THROTTLED_ASKS throttles, the last one as
// it came; otherwise how the round ended (roundEnd).
const placed = async (g: Gateway, outgoing: Outgoing, asked: Pinnable, candidates: readonly PinCandidate[]): Promise<Response | undefined> => {
    const round: Round = { throttles: 0, benched: [], unrouted: [], offPlanned: [] };
    for (const candidate of candidates) {
        const askedAt = g.clock();
        const { url, method, headers, signal } = outgoing;
        const response = await g.send(url, { method, headers, body: pinnedBody(asked, candidate.prefix), signal });
        if (response.ok) {
            return answered(response, settleOn(g, asked, candidate, askedAt, signal));
        }
        const refusal = await readRefusal(response);
        if (passedOver(g, asked, candidate, refusal, round)) {
            continue;
        }
        const cause = causeOf(refusal, g.clock());
        if (cause === undefined) {
            return handedOn(refusal);
        }
        round.last = { refusal, cause };
        if (cause === "benched") {
            round.benched.push(candidate.account);
        }
        if (cause === "spent") {
            await fileRefusal(g, asked, candidate, refusal);
        } else if (cause === "throttled" && ++round.throttles >= THROTTLED_ASKS) {
            return handedThrottle(g, asked, refusal, round.throttles);
        }
    }
    return roundEnd(g, asked, round);
};

// The pinned answer, or undefined where there is no account to pin the request to.
const pinnedAnswer = async (g: Gateway, outgoing: Outgoing, asked: Pinnable): Promise<Response | undefined> => {
    let candidates: readonly PinCandidate[];
    try {
        candidates = await g.candidates(asked.provider, asked.model);
    } catch (error) {
        g.logger.warn({ err: error, provider: asked.provider, model: asked.model }, "translator gateway: the accounts could not be ranked, sending unpinned");
        return undefined;
    }
    return candidates.length === 0 ? undefined : placed(g, outgoing, asked, candidates);
};

// The request as it came, to whichever credential the translator picks.
const unpinned = async (g: Gateway, outgoing: Outgoing): Promise<Response> => {
    const init: RequestInit = { method: outgoing.method, headers: outgoing.headers, signal: outgoing.signal };
    if (outgoing.raw !== undefined) {
        init.body = outgoing.raw;
    }
    const response = await g.send(outgoing.url, init);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: forwardHeaders(response.headers, RESPONSE_REFRAMED) });
};

const routeOf =
    (g: Gateway) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        // An address this daemon did not sign, or one for a provider with nothing behind the gateway, is no address.
        const session = c.req.param("session") ?? "";
        const provider = await g.sessions.verify(session);
        if (provider === undefined) {
            return Response.json({ error: "unknown translator gateway session" }, { status: 404 });
        }
        // The bearer as well, as the translator itself would ask it.
        if (g.translator.token === "" || !tokenEquals(presented(c.req.raw.headers), g.translator.token)) {
            return failure(401, "authentication_error", "This is the model translator's door, and the request did not carry its bearer.");
        }
        const outgoing = await outgoingOf(c, g.translator.url, session);
        try {
            const asked = pinnableOf(provider, c.req.header("content-type") ?? null, outgoing.raw);
            return (asked === undefined ? undefined : await pinnedAnswer(g, outgoing, asked)) ?? (await unpinned(g, outgoing));
        } catch (error) {
            if (outgoing.signal.aborted) {
                return new Response(null, { status: 499 });
            }
            g.logger.warn({ err: error, provider }, "translator gateway: the translator could not be reached");
            return failure(502, "api_error", `The model translator could not be reached (${error instanceof Error ? error.message : "network error"}).`);
        }
    };

export const createTranslatorGateway = (deps: TranslatorGatewayDeps): TranslatorGateway => {
    const g: Gateway = { ...deps, send: deps.fetch ?? fetch, clock: deps.now ?? Date.now, attributed: new Map(), throttled: new Map() };
    return {
        route: routeOf(g),
        baseUrlFor: async (provider) => `${deps.loopbackBase}${TRANSLATOR_GATEWAY_PATH}/${await deps.sessions.sign(provider)}`,
        attributedAt: (provider, model) => g.attributed.get(`${provider}:${model}`),
        throttledAt: (provider, model) => g.throttled.get(`${provider}:${model}`),
    };
};

/** The daemon's translator gateway, over its finished services: what the raw route serves and a turn's failure reads. */
export interface TranslatorGatewaySlice {
    readonly translatorGateway: TranslatorGateway;
}

export const translatorGatewaySlice = defineSlice<TranslatorGatewaySlice>({
    build: ({ config, logger, authRoot, whole }: Pick<CompositionCore, "config" | "logger" | "authRoot" | "whole">) => ({
        translatorGateway: createTranslatorGateway({
            translator: config.translator,
            loopbackBase: `http://127.0.0.1:${String(config.sandbox.port)}`,
            sessions: translatorGatewaySessions(join(authRoot, SESSION_KEY_FILE)),
            // Credentials signed in since the last round get their prefixes first; a refused one stays out of the ranking.
            candidates: async (provider, model) => {
                const services = whole();
                await services.cliProxy
                    .pinAccounts({ maxAgeMs: PIN_MAX_AGE_MS })
                    .then((report) => logPins(logger, report))
                    .catch((error: Error) => logger.warn({ err: error }, "translator: could not pin credentials"));
                return pinnedCandidates(services, provider, model);
            },
            refusals: {
                record: (provider, refusal) => whole().providerRefusals.record(provider, refusal),
                settle: (provider, answer) => whole().providerRefusals.settle(provider, answer),
            },
            covers: async (provider, account, model) => {
                const reading = (await whole().headroom.read())[usageKey(provider, account)];
                return (other) => other !== model && answerCovers(reading, { id: model }, { id: other });
            },
            reread: (provider, account) =>
                void whole().headroom.refresh({ scope: { providers: [provider], account: usageKey(provider, account) }, maxAgeMs: 0 }),
            unrouted: (_provider, account) => whole().cliProxy.recheckModels(account),
            offPlan: (_provider, account, model) => void whole().cliProxy.refuseModel(account, model),
            logger,
        }),
    }),
});
