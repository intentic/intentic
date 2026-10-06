import type { Broker, BrokerRoute, CapabilityContribution } from "@intentic/extension-manifest";
import { expandFieldTemplate, fieldsNamedIn } from "../contributions.js";

// What a connector's `broker` declaration means for one card: each upstream the credential is for, expanded over the
// card's own settings, with the headers (or path) that carry the credential there. The gateway forwards only to an
// upstream listed here and attaches only what is listed here, so the declaration is the whole of where a brokered
// credential can go and how.

// What a variable that used to hold a brokered secret holds instead: inert, the same for every card, and saying where the
// credential went for anyone who reads it. Sent anywhere, it authenticates nothing; sent to the gateway, it is replaced.
export const GATEWAY_PLACEHOLDER = "held-by-the-credential-gateway";

export interface ExpandedRoute {
    // Position in the declaration; stable across a card's own setting changes, unlike the upstream.
    readonly index: number;
    // The service's base: origin plus a path without a trailing slash, never a query or fragment.
    readonly upstream: URL;
    // The variable the agent's shell finds this route's gateway address in, before the per-instance suffix.
    readonly env: string | undefined;
    // The headers the gateway sets, names lower-cased; an empty object for a route whose credential rides the path.
    readonly headers: Readonly<Record<string, string>>;
    // Put before the agent's own path; "" when the credential does not ride the path.
    readonly pathPrefix: string;
    // Set in a url-encoded form body; an empty object for a route whose credential does not ride the body.
    readonly form: Readonly<Record<string, string>>;
    // Serves git over HTTP, so the agent's git is rewritten onto the gateway for it.
    readonly git: boolean;
    // The fields this route's credential is made of, the registry names its uses are recorded under.
    readonly fields: readonly string[];
}

export const brokerOf = (spec: CapabilityContribution): Broker | undefined => (spec.kind === "cli" ? spec.broker : undefined);

// A header value that could end one header and start another is refused outright: settings are the owner's, but a
// pasted token with a stray newline must not become a second header the gateway sends with the owner's credential.
const headerSafe = (value: string): boolean => !/[\r\n\0]/.test(value);

const normalizedUpstream = (raw: string): URL | undefined => {
    const url = URL.parse(raw);
    if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
        return undefined;
    }
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url;
};

const credentialHeaders = (route: BrokerRoute, config: Readonly<Record<string, string>>): Record<string, string> | undefined => {
    const headers: Record<string, string> = {};
    for (const [name, template] of Object.entries(route.headers ?? {})) {
        headers[name.toLowerCase()] = expandFieldTemplate(template, config);
    }
    if (route.basic !== undefined) {
        const pair = `${expandFieldTemplate(route.basic.username, config)}:${expandFieldTemplate(route.basic.password, config)}`;
        headers["authorization"] = `Basic ${Buffer.from(pair).toString("base64")}`;
    }
    return Object.values(headers).every(headerSafe) ? headers : undefined;
};

const routeFields = (route: BrokerRoute): string[] => {
    const templates = [
        ...Object.values(route.headers ?? {}),
        ...Object.values(route.form ?? {}),
        route.basic?.username ?? "",
        route.basic?.password ?? "",
        route.pathPrefix ?? "",
    ];
    return [...new Set(templates.flatMap((template) => [...fieldsNamedIn(template)]))];
};

/**
 * Every route of a card's broker, expanded over its settings. A route whose upstream comes out as no http(s) URL (an
 * unanswered field), or whose credential would not make a well-formed header or path, is left out rather than guessed.
 */
export const brokerRoutes = (broker: Broker, config: Readonly<Record<string, string>>): ExpandedRoute[] =>
    broker.routes.flatMap((route, index) => {
        const upstream = normalizedUpstream(expandFieldTemplate(route.upstream, config));
        const headers = credentialHeaders(route, config);
        const pathPrefix = route.pathPrefix === undefined ? "" : expandFieldTemplate(route.pathPrefix, config);
        if (upstream === undefined || headers === undefined || /[\s?#]/.test(pathPrefix)) {
            return [];
        }
        const form = Object.fromEntries(Object.entries(route.form ?? {}).map(([name, template]) => [name, expandFieldTemplate(template, config)]));
        return [{ index, upstream, env: route.env, headers, pathPrefix, form, git: route.git === true, fields: routeFields(route) }];
    });

/** The `env` variables whose template names a secret field: what holds the placeholder once the card is brokered. */
export const secretBearingEnv = (spec: CapabilityContribution): ReadonlySet<string> => {
    if (spec.kind !== "cli") {
        return new Set();
    }
    const secret = new Set(spec.fields.filter((field) => field.secret === true).map((field) => field.key));
    return new Set(
        Object.entries(spec.env).flatMap(([name, template]) => ([...fieldsNamedIn(template)].some((field) => secret.has(field)) ? [name] : [])),
    );
};
