import type { Broker, BrokerRule } from "@intentic/extension-manifest";
import { oneLine } from "@intentic/base/one-line";
import { hostAllowed } from "@intentic/sandbox-contract/policy/secret-hosts";
import type { SecretHostGuard } from "@intentic/sandbox-contract/schemas/secrets";
import { credentialRequest } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { REQUEST_REFRAMED, RESPONSE_REFRAMED, forwardHeaders } from "../../http/forward-headers.js";
import type { CredentialGate } from "../../secrets/gates/credential-gate.js";
import { brokerRoutes, type ExpandedRoute, GATEWAY_PLACEHOLDER } from "./broker-routes.js";
import { effectiveRules, evaluateRules, ruleIdentity } from "./broker-rules.js";
import type { BrokerSessions } from "./broker-session.js";
import { createOpenCalls, credentialPrint, type OpenCall, type OpenCalls } from "../credentials/open-calls.js";

// The credential gateway: where a brokered credential is attached to a request, and the only place it ever is. A request
// arrives on the loopback listener at `/<session>/<path>`; the signed session names the card and the upstream, the card's
// live declaration says how its credential rides, and every check runs here, on the request itself, before anything is
// forwarded: the owner's host guard, the card's method and path rules, its named approvers. What the agent holds (the
// address and an inert placeholder) authenticates nothing anywhere else, so none of these checks can be stepped around
// by rewording a command, the way a check that reads command text could be.

export interface GatewayCard {
    // The card's settings with its secrets in them, read live: a rotated token is used from the next request.
    readonly config: Readonly<Record<string, string>>;
    readonly broker: Broker;
    // What the card is called, for the cards and refusals a person reads.
    readonly name: string;
}

export interface RuleAsk {
    readonly capability: string;
    readonly name: string;
    // The rule that asked, as its own content (ruleIdentity), so a pass left by "allow in this conversation" follows that
    // rule and nothing that later takes its place in the list.
    readonly rule: string;
    readonly why: string | undefined;
    readonly method: string;
    // Host and path, never the query: a query can carry what the agent put there, which a card has no need to show.
    readonly target: string;
    readonly conversationId: string | undefined;
    readonly signal: AbortSignal;
}

export type GatewayAnswer = { readonly allow: true; readonly approvedBy?: string } | { readonly allow: false; readonly reason: string };

// The `ask` rules' person: whether a card can be raised, whether this conversation already let a rule through, and the
// card itself (broker-prompts.ts).
export interface RulePrompts {
    readonly canPark: (conversationId: string | undefined) => boolean;
    readonly passed: (conversationId: string | undefined, capability: string, rule: string) => boolean;
    readonly ask: (input: RuleAsk) => Promise<GatewayAnswer>;
}

// One forwarded request, for the use ledger: the registry names its credential is made of, and where it went.
export interface GatewayUse {
    readonly capability: string;
    readonly fields: readonly string[];
    readonly conversationId: string | undefined;
    readonly detail: string;
    readonly approvedBy?: string;
}

export interface GatewayDeps {
    readonly sessions: Pick<BrokerSessions, "verify">;
    // The card behind a capability id, undefined when it is gone or its connector declares no broker.
    readonly card: (capability: string) => Promise<GatewayCard | undefined>;
    readonly ownerRules: (capability: string) => Promise<readonly BrokerRule[] | undefined>;
    readonly hostGuards: () => Promise<readonly SecretHostGuard[]>;
    readonly credentialGate: Pick<CredentialGate, "check">;
    readonly prompts: RulePrompts;
    readonly used: (use: GatewayUse) => void;
    readonly fetch?: typeof fetch;
    // Whether the conversation may still spend this capability (credential-reach.ts), for the sweep of open calls; the
    // credential gate asks it of each new one. Absent, nobody is limited.
    readonly reaches?: (conversationId: string | undefined, capability: string) => Promise<boolean>;
    // How many calls the gateway carries at once, and the open ones it cuts (open-calls.ts).
    readonly openCalls?: OpenCalls;
}

const DETAIL_MAX = 80;

// A form-borne credential rides an OAuth token exchange, which is a few hundred bytes; anything far larger is not one.
const FORM_MAX_BYTES = 64 * 1024;

const isForm = (type: string | null): boolean => type !== null && /^application\/x-www-form-urlencoded\b/iu.test(type);

// The agent's form with the route's fields set over whatever it sent under those names; undefined when the body is not
// a form, or too large to be the exchange the route is for.
const formBody = async (request: Request, fields: Readonly<Record<string, string>>): Promise<string | undefined> => {
    if (!isForm(request.headers.get("content-type"))) {
        return undefined;
    }
    const raw = await request.arrayBuffer();
    if (raw.byteLength > FORM_MAX_BYTES) {
        return undefined;
    }
    const params = new URLSearchParams(new TextDecoder().decode(raw));
    for (const [name, value] of Object.entries(fields)) {
        params.set(name, value);
    }
    return params.toString();
};

// Shaped like the services' own errors (`message`), so a client that prints an API's error prints this sentence.
const refused = (status: number, message: string): Response =>
    new Response(JSON.stringify({ message, gateway: "intentic" }), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "x-intentic-gateway": "refused" },
    });

// `/<session>/<rest>` split; the rest keeps its own trailing slash and percent-encoding, which the upstream reads.
const splitPath = (pathname: string): { readonly token: string; readonly rest: string } => {
    const slash = pathname.indexOf("/", 1);
    return slash === -1 ? { token: pathname.slice(1), rest: "/" } : { token: pathname.slice(1, slash), rest: pathname.slice(slash) };
};

const basePath = (route: ExpandedRoute): string => (route.upstream.pathname === "/" ? "" : route.upstream.pathname);

// A redirect back onto the same service is pointed at the gateway again, so the client's next hop carries the credential
// the same way; one anywhere else (a signed download URL) goes as the service sent it, without it.
const relocated = (location: string, route: ExpandedRoute, gatewayBase: string): string => {
    const target = URL.parse(location, route.upstream);
    if (target === null || target.origin !== route.upstream.origin) {
        return location;
    }
    const prefix = `${basePath(route)}${route.pathPrefix}`;
    if (!target.pathname.startsWith(prefix)) {
        return location;
    }
    return `${gatewayBase}${target.pathname.slice(prefix.length) || "/"}${target.search}`;
};

const errorCode = (error: unknown): string => {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    return typeof cause?.code === "string" ? cause.code : "the connection failed";
};

// The card's credential as it stands, so a call admitted under one is cut once it is replaced.
const cardPrint = (card: GatewayCard): string =>
    credentialPrint(
        Object.entries(card.config)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .flat(),
    );

// Why an open call through the gateway may no longer run, or undefined while it may.
const staleness =
    (deps: GatewayDeps) =>
    async (call: OpenCall): Promise<string | undefined> => {
        const card = await deps.card(call.subject);
        if (card === undefined) {
            return `the connected card "${call.subject}" was removed, or no longer routes its credential through the gateway`;
        }
        if (cardPrint(card) !== call.print) {
            return `the connected card "${call.subject}" was given another credential`;
        }
        if (deps.reaches !== undefined && !(await deps.reaches(call.conversationId, call.subject))) {
            return `this conversation may no longer use "${call.subject}"`;
        }
        return undefined;
    };

// An event stream (server-sent events) stays open for as long as its client reads it, so it has its own pool.
const poolOf = (request: Request): OpenCall["pool"] =>
    request.method.toUpperCase() === "GET" && (request.headers.get("accept") ?? "").includes("text/event-stream") ? "stream" : "call";

export const createGateway = (deps: GatewayDeps): ((request: Request) => Promise<Response>) => {
    const openCalls = deps.openCalls ?? createOpenCalls();
    openCalls.watch(staleness(deps));
    const serve = serveGateway(deps);
    return async (request) => {
        const url = new URL(request.url);
        const { token, rest } = splitPath(url.pathname);
        const session = token === "" ? undefined : await deps.sessions.verify(token);
        if (session === undefined) {
            return refused(
                404,
                "This is not a credential gateway address this sandbox issued. Use the one in your environment (the connected tool's skill names the variable); each turn's environment carries a fresh one.",
            );
        }
        const { capability, conversationId } = session;
        const card = await deps.card(capability);
        if (card === undefined) {
            return refused(
                410,
                `The connected card "${capability}" behind this address is gone, or no longer routes its credential through the gateway.`,
            );
        }
        const admitted = openCalls.admit({ subject: capability, conversationId, pool: poolOf(request), print: cardPrint(card) }, request.signal);
        if (admitted === undefined) {
            return refused(
                429,
                `Too many requests through the credential gateway are open at once${conversationId === undefined ? "" : " for this conversation"}; wait for one to finish, then retry.`,
            );
        }
        try {
            return admitted.hold(await serve(request, admitted.signal, url, token, rest, session, card));
        } catch (error) {
            admitted.release();
            throw error;
        }
    };
};

const serveGateway = (deps: GatewayDeps) => {
    const fetchImpl = deps.fetch ?? fetch;
    return async (
        request: Request,
        // The request's own, joined with the gateway's cut of the call.
        signal: AbortSignal,
        url: URL,
        token: string,
        rest: string,
        session: NonNullable<Awaited<ReturnType<BrokerSessions["verify"]>>>,
        card: GatewayCard,
    ): Promise<Response> => {
        const { capability, conversationId } = session;
        const route = brokerRoutes(card.broker, card.config).find(
            (candidate) => candidate.index === session.route && candidate.upstream.href === session.upstream,
        );
        if (route === undefined) {
            return refused(
                410,
                `This gateway address for "${capability}" is out of date: the card's settings changed since it was issued. The next turn's environment has the current one.`,
            );
        }
        const method = request.method.toUpperCase();
        const where = `${route.upstream.host}${basePath(route)}${rest}`;
        const detail = oneLine(`${method} ${where}`, DETAIL_MAX);

        // Where: the owner's host guard for the card, which may have narrowed what its connector declared.
        let guards: readonly SecretHostGuard[];
        try {
            guards = await deps.hostGuards();
        } catch {
            return refused(
                503,
                "The owner's secret host guards could not be read, so the credential was not attached. Do not retry: tell the owner.",
            );
        }
        const hostGuard = guards.find((entry) => entry.kind === "capability" && entry.subject === capability);
        if (hostGuard?.guard === true && !hostAllowed(hostGuard.hosts, route.upstream.hostname)) {
            return refused(
                403,
                `${card.name}'s host guard does not list ${route.upstream.hostname}, so its credential was not attached. Only the owner can add it, on the Secrets view.`,
            );
        }

        // What: the card's method and path rules.
        let rules: readonly BrokerRule[];
        try {
            rules = effectiveRules(await deps.ownerRules(capability), card.broker.rules);
        } catch {
            return refused(
                503,
                `The owner's rules for ${card.name} could not be read, so its credential was not attached. Do not retry: tell the owner.`,
            );
        }
        const ruling = evaluateRules(rules, method, rest);
        const asking = ruling.action === "allow" ? undefined : ruleIdentity(rules[ruling.rule]);
        const verdict = guard(credentialRequest, {
            rule: ruling.action,
            passed: ruling.action === "ask" && asking !== undefined && deps.prompts.passed(conversationId, capability, asking),
            canPark: deps.prompts.canPark(conversationId),
        });
        let approvedBy: string | undefined;
        if (verdict.effect === "deny") {
            const why = ruling.action === "allow" ? undefined : ruling.why;
            return refused(
                403,
                `${card.name}: ${verdict.reason}${why === undefined ? "" : ` (${why})`}: ${detail}. Do not retry it; say what you left undone.`,
            );
        }
        if (verdict.effect === "hold" && ruling.action !== "allow") {
            const answer = await deps.prompts.ask({
                capability,
                name: card.name,
                rule: asking ?? "",
                why: ruling.why,
                method,
                target: where,
                conversationId,
                signal,
            });
            if (!answer.allow) {
                return refused(403, answer.reason);
            }
            approvedBy = answer.approvedBy;
        }

        // Who: the card's named approvers, the same gate every other exit consults.
        const released = await deps.credentialGate.check({
            subject: capability,
            kind: "capability",
            lane: "gateway",
            detail,
            conversationId,
            signal,
        });
        if (!released.allow) {
            return refused(403, released.reason);
        }
        approvedBy = released.approvedBy ?? approvedBy;

        const target = new URL(route.upstream.href);
        target.pathname = `${basePath(route)}${route.pathPrefix}${rest}`;
        target.search = url.search;
        // `accept-encoding` is among the reframed headers, so the answer arrives as the bytes fetch hands back, with no
        // encoding header left claiming otherwise. What the route sets itself is never the agent's to send.
        const headers = forwardHeaders(request.headers, [...REQUEST_REFRAMED, ...Object.keys(route.headers)]);
        // The placeholder never leaves: any header carrying it was the agent's own attempt at the credential.
        // Named first and deleted after, since deleting from Headers while iterating it skips the entry that follows.
        const carrying = [...headers].filter(([, value]) => value.includes(GATEWAY_PLACEHOLDER)).map(([name]) => name);
        for (const name of carrying) {
            headers.delete(name);
        }
        for (const [name, value] of Object.entries(route.headers)) {
            headers.set(name, value);
        }
        const hasBody = method !== "GET" && method !== "HEAD";
        let body: BodyInit | null = hasBody ? request.body : null;
        if (Object.keys(route.form).length > 0) {
            const form = hasBody ? await formBody(request, route.form) : undefined;
            if (form === undefined) {
                return refused(
                    400,
                    `This ${card.name} address takes a url-encoded form body (a token exchange) of at most ${String(FORM_MAX_BYTES / 1024)} KiB.`,
                );
            }
            body = form;
        }
        let upstream: Response;
        try {
            upstream = await fetchImpl(target, {
                method,
                headers,
                ...(body === null ? {} : { body, duplex: "half" }),
                // Followed by the client, through relocated(): a redirect followed here would carry the credential to
                // wherever the service pointed.
                redirect: "manual",
                signal,
            } as RequestInit);
        } catch (error) {
            // The host and a code only: an error's own text can quote the URL, and a path-borne credential is in it.
            return refused(502, `${route.upstream.host} could not be reached through the gateway (${errorCode(error)}).`);
        }
        deps.used({ capability, fields: route.fields, conversationId, detail, ...(approvedBy !== undefined ? { approvedBy } : {}) });

        const answer = forwardHeaders(upstream.headers, RESPONSE_REFRAMED);
        const location = upstream.headers.get("location");
        if (location !== null) {
            answer.set("location", relocated(location, route, `${url.origin}/${token}`));
        }
        return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: answer });
    };
};
