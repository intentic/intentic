import type { Broker, BrokerRule } from "@intentic/extension-manifest";
import { hostAllowed, type SecretHostGuard } from "@intentic/sandbox-contract";
import { credentialRequest } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import type { CredentialGate } from "../../secrets/gates/credential-gate.js";
import { brokerRoutes, type ExpandedRoute, GATEWAY_PLACEHOLDER } from "./broker-routes.js";
import { effectiveRules, evaluateRules } from "./broker-rules.js";
import type { BrokerSessions } from "./broker-session.js";

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
    readonly rule: number;
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
    readonly passed: (conversationId: string | undefined, capability: string, rule: number) => boolean;
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
}

// What describes this connection or the agent's own client rather than the request: never forwarded. `accept-encoding`
// too, so the answer arrives as the bytes fetch hands back, with no encoding header left claiming otherwise.
const REQUEST_DROPPED = new Set([
    "host",
    "connection",
    "keep-alive",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "accept-encoding",
]);
const RESPONSE_DROPPED = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "upgrade"]);

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

const clipped = (text: string): string => (text.length <= DETAIL_MAX ? text : `${text.slice(0, DETAIL_MAX)}…`);

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

export const createGateway = (deps: GatewayDeps): ((request: Request) => Promise<Response>) => {
    const fetchImpl = deps.fetch ?? fetch;
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
        const detail = clipped(`${method} ${where}`);

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
        const verdict = guard(credentialRequest, {
            rule: ruling.action,
            passed: ruling.action === "ask" && deps.prompts.passed(conversationId, capability, ruling.rule),
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
                rule: ruling.rule,
                why: ruling.why,
                method,
                target: where,
                conversationId,
                signal: request.signal,
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
            signal: request.signal,
        });
        if (!released.allow) {
            return refused(403, released.reason);
        }
        approvedBy = released.approvedBy ?? approvedBy;

        const target = new URL(route.upstream.href);
        target.pathname = `${basePath(route)}${route.pathPrefix}${rest}`;
        target.search = url.search;
        const headers = new Headers();
        for (const [name, value] of request.headers) {
            const lower = name.toLowerCase();
            // The placeholder never leaves: any header carrying it was the agent's own attempt at the credential.
            if (!REQUEST_DROPPED.has(lower) && !(lower in route.headers) && !value.includes(GATEWAY_PLACEHOLDER)) {
                headers.append(name, value);
            }
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
                signal: request.signal,
            } as RequestInit);
        } catch (error) {
            // The host and a code only: an error's own text can quote the URL, and a path-borne credential is in it.
            return refused(502, `${route.upstream.host} could not be reached through the gateway (${errorCode(error)}).`);
        }
        deps.used({ capability, fields: route.fields, conversationId, detail, ...(approvedBy !== undefined ? { approvedBy } : {}) });

        const answer = new Headers();
        for (const [name, value] of upstream.headers) {
            if (!RESPONSE_DROPPED.has(name.toLowerCase())) {
                answer.append(name, value);
            }
        }
        const location = upstream.headers.get("location");
        if (location !== null) {
            answer.set("location", relocated(location, route, `${url.origin}/${token}`));
        }
        return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: answer });
    };
};
