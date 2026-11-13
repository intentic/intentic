import type { Context } from "hono";
import type { Logger } from "pino";
import { answerCovers, preferredAccount } from "@intentic/sandbox-contract/models/plan-pools";
import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { join } from "node:path";
import type { KeyedProvider } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { parseJsonOr } from "@intentic/base/json";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import type { CompositionCore } from "../../composition.js";
import { tokenEquals } from "../../auth/token-equals.js";
import { mentionsSpentAllowance } from "../../engines/failure-sentences.js";
import { readableProviderText } from "../../engines/provider-error-text.js";
import { REQUEST_REFRAMED, RESPONSE_REFRAMED, forwardHeaders } from "../../http/forward-headers.js";
import { TRANSLATOR_GATEWAY_PATH } from "../../http/translator-gateway-url.js";
import { defineSlice } from "../../seams/slice.js";
import type { ProviderRefusalStore } from "../../usage/provider-refusals.js";
import { namedReset } from "../../usage/reset-sentences.js";
import { serviceabilities, type ServiceabilityDeps } from "../../usage/serviceability/serviceability.js";
import { opt } from "../../opt.js";
import { usageKey } from "./translator.js";
import { logPins } from "./translator-prefixes.js";
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
   so an unsigned address is answered as no address at all, before the bearer is even read. One whose JSON
   body names a model is placed by the sandbox's one rule (serviceability.ts, plan-pools.ts preferredAccount): the
   provider's accounts that can serve that model, best first, then a spent one or two (SPENT_PROBES), each asked for by
   its own prefix (`<prefix>/<model>`, translator-prefixes.ts), which the translator serves on that credential alone. A
   spent allowance comes back from a known account: it is filed under that account with the provider's own words and
   reset, the account is re-read, and the next one is tried, each at most once per request. An answer streams through untouched and, once it has come
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

// A model id the gateway already pinned (translator-prefixes.ts accountPrefix), which is never pinned again.
const PINNED_MODEL = /^ic-[0-9a-f]{10}\//u;

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
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
}

/* A SPENT ACCOUNT IS STILL ASKED, AFTER EVERY ONE WITH ROOM. A refusal this gateway filed names its account, and only
   an answer pinned to that account settles it (settleOn): the turn's own answer names the subscription, not the account
   the request landed on (frame-effects.ts readingAccount), and a refusal that named its reset outranks every reading of
   the account until then (refusal-verdict.ts verdictOn). Left out of the ranking, a spent account was never asked again,
   so once every account read spent each request went unpinned, was answered, and settled nothing: a ChatGPT allowance
   OpenAI reset early read empty in every window while the person's forced Codex sends went through, and the composer
   kept booking them for the old reset (2026-11-13). So after every account with room, the spent ones that refused
   longest ago are asked too, at most SPENT_PROBES of them: one still spent refuses again at the cost of a round trip, and
   the one that answers is settled the moment its answer comes whole. A bench, a revoked sign-in or a lost seat is never
   asked: no window reopening lifts those. */
const SPENT_PROBES = 2;

/**
 * The accounts of a routed provider a request for `model` may be pinned to: those the verdict says can serve it (ready,
 * or nothing known against them), best first by the one rule every pick follows, then at most SPENT_PROBES the verdict
 * calls spent, the one refused longest ago first; only those the translator knows by their prefix.
 */
export const pinnedCandidates = async (deps: ServiceabilityDeps, provider: KeyedProvider, model: string): Promise<readonly PinCandidate[]> => {
    const [rows, onFile] = await Promise.all([serviceabilities(deps, provider, { id: model }), deps.providerRefusals.onFile()]);
    const left = rows.filter((row) => row.state.kind === "ready" || row.state.kind === "unknown");
    const ranked: PinCandidate[] = [];
    for (let best = preferredAccount(left); best !== undefined; best = preferredAccount(left)) {
        left.splice(left.indexOf(best), 1);
        const prefix = deps.cliProxy.accountPrefix(best.id);
        if (prefix !== undefined) {
            ranked.push({ account: best.id, prefix });
        }
    }
    // When each account was last refused, so a probe goes round them rather than asking the same one every time.
    const refusedAt = (account: string): number =>
        Math.max(0, ...(onFile[provider] ?? []).flatMap((refusal) => (refusal.account === account ? [refusal.at] : [])));
    const probes = rows
        .filter((row) => row.state.kind === "spent")
        .toSorted((one, other) => refusedAt(one.id) - refusedAt(other.id))
        .flatMap((row) => {
            const prefix = deps.cliProxy.accountPrefix(row.id);
            return prefix === undefined ? [] : [{ account: row.id, prefix }];
        });
    return [...ranked, ...probes.slice(0, SPENT_PROBES)];
};

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
    return !body.success || PINNED_MODEL.test(body.data.model) ? undefined : { provider, model: body.data.model, body: body.data };
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

// A spent allowance: the provider's 429, or its quota words under another status (Google's RESOURCE_EXHAUSTED).
const spent = (refusal: ReadRefusal): boolean =>
    refusal.status === 429 || (refusal.status >= 400 && (mentionsSpentAllowance(refusal.text) || /RESOURCE_EXHAUSTED/u.test(refusal.text)));

// The translator does not route this prefixed model to that credential: the plan does not cover the model, or the
// translator has not registered the prefix yet. Not the account's refusal; the next one is asked.
const unroutable = (refusal: ReadRefusal, prefix: string): boolean =>
    refusal.status === 400 && refusal.text.includes("model_not_found") && refusal.text.includes(`${prefix}/`);

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

// The gateway's deps with its defaults filled, and what it remembers: when it last filed a refusal for each model.
interface Gateway extends TranslatorGatewayDeps {
    readonly send: typeof fetch;
    readonly clock: () => number;
    readonly attributed: Map<string, number>;
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

// Asks each candidate in turn, at most once, until one answers or refuses for something other than a spent allowance.
// Every one refused: the last refusal as it came. None routed the prefix at all: undefined, and the caller sends unpinned.
const placed = async (g: Gateway, outgoing: Outgoing, asked: Pinnable, candidates: readonly PinCandidate[]): Promise<Response | undefined> => {
    let last: ReadRefusal | undefined;
    for (const candidate of candidates) {
        const askedAt = g.clock();
        const { url, method, headers, signal } = outgoing;
        const response = await g.send(url, { method, headers, body: pinnedBody(asked, candidate.prefix), signal });
        if (response.ok) {
            return answered(response, settleOn(g, asked, candidate, askedAt, signal));
        }
        const refusal = await readRefusal(response);
        if (unroutable(refusal, candidate.prefix)) {
            continue;
        }
        if (!spent(refusal)) {
            return handedOn(refusal);
        }
        await fileRefusal(g, asked, candidate, refusal);
        last = refusal;
    }
    return last === undefined ? undefined : handedOn(last);
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
    const g: Gateway = { ...deps, send: deps.fetch ?? fetch, clock: deps.now ?? Date.now, attributed: new Map() };
    return {
        route: routeOf(g),
        baseUrlFor: async (provider) => `${deps.loopbackBase}${TRANSLATOR_GATEWAY_PATH}/${await deps.sessions.sign(provider)}`,
        attributedAt: (provider, model) => g.attributed.get(`${provider}:${model}`),
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
            logger,
        }),
    }),
});
