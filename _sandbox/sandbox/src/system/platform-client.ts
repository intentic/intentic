import {
    CONNECT_TOKEN_HEADER,
    type IngressInput,
    type IngressOutput,
    type IngressRouteName,
    type IngressRouteSpec,
    ingressRefusalOf,
    PLATFORM_INGRESS,
} from "@intentic/api-contract/ingress";
import { errorMessage } from "@intentic/base/errors";
import type { Config } from "../env.config.js";
import { isLocalHost } from "./tls/local-tls.js";
import { nodeRequest } from "./tls/node-request.js";
import { parseJsonOr } from "@intentic/base/json";

// Every platform call is one exchange over node:https (nodeRequest): undici can skip a dev platform's self-signed cert
// only process-wide.

// How long a platform socket may stay quiet before the exchange is cut, unless a caller asks for less: every call gets
// one, since a platform that accepts the connection and never answers would otherwise hold its caller (a report loop
// that schedules its next attempt only after this one) for good.
export const PLATFORM_IDLE_MS = 60_000;

export interface PlatformExchange {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly payload?: string;
    // Cuts a socket that has gone quiet this long (PLATFORM_IDLE_MS unless set), rejecting with `idleError`; `signal`
    // bounds the whole exchange.
    readonly idleMs?: number;
    readonly idleError?: string;
    readonly signal?: AbortSignal;
}

export interface PlatformAnswer {
    readonly status: number;
    readonly body: string;
    readonly contentType: string | undefined;
}

// Resolves with whatever the platform answered, a refusal included; rejects only when it could not be reached.
export const exchangeWithPlatform = async (config: Config, call: PlatformExchange): Promise<PlatformAnswer> => {
    const url = new URL(call.path, config.platform.url);
    const idleError = call.idleError ?? "the platform did not respond in time";
    const answer = await nodeRequest(url, {
        method: call.method,
        headers: { ...call.headers, ...(call.payload === undefined ? {} : { "content-type": "application/json" }) },
        body: call.payload,
        insecure: isLocalHost(url.hostname),
        idleMs: call.idleMs ?? PLATFORM_IDLE_MS,
        idleError: () => new Error(idleError),
        signal: call.signal,
    });
    const contentType = answer.headers["content-type"];
    return { status: answer.status, body: answer.body.toString("utf8"), contentType };
};

/* THE PLATFORM'S ROUTES, CALLED BY NAME. Each is declared once in api-contract's PLATFORM_INGRESS, which the platform
 * registers its handlers under: the method, the path, the body's shape and the answer's come from there, and so does
 * which credential it takes. This daemon calls the routes a sandbox calls as itself (its connect token) and the ones
 * it calls for its owner's account (a provisioning token the caller hands in). */

type SandboxAuth = "connect" | "connect-bearer" | "provisioning";
export type DaemonIngressRoute = {
    [K in IngressRouteName]: (typeof PLATFORM_INGRESS)[K]["auth"] extends SandboxAuth ? K : never;
}[IngressRouteName];

export interface IngressCall<K extends DaemonIngressRoute> {
    readonly route: K;
    // The body, typed by the route's schema; a JSON route sent none posts `{}`, as every caller always has.
    readonly input?: IngressInput<K>;
    // The account's provisioning token, for the routes that take one rather than this sandbox's connect token.
    readonly bearer?: string;
    readonly idleMs?: number;
    readonly idleError?: string;
    readonly signal?: AbortSignal;
}

// One route's request as it goes on the wire; undefined when there is no credential to present for it.
export const ingressExchange = <K extends DaemonIngressRoute>(config: Config, call: IngressCall<K>): PlatformExchange | undefined => {
    const route: IngressRouteSpec = PLATFORM_INGRESS[call.route];
    const credential = route.auth === "provisioning" ? (call.bearer ?? "") : config.connectToken;
    if (credential === "") {
        return undefined;
    }
    return {
        method: route.method,
        path: route.path,
        headers: route.auth === "provisioning" ? { authorization: `Bearer ${credential}` } : { [CONNECT_TOKEN_HEADER]: credential },
        ...(route.body === "json" ? { payload: JSON.stringify(call.input ?? {}) } : {}),
        ...(call.idleMs === undefined ? {} : { idleMs: call.idleMs }),
        ...(call.idleError === undefined ? {} : { idleError: call.idleError }),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
    };
};

const jsonOf = (body: string): unknown => {
    // An unparseable body is an answer without JSON, which every caller reads as undefined.
    return parseJsonOr(body, undefined);
};

export interface IngressAnswer<O> {
    readonly status: number;
    // A success's body as the route's answer schema reads it; undefined for a refusal, or a body it does not read.
    readonly data: O | undefined;
    // A refusal's sentence, however the platform spelled it (`ingressRefusalOf`): `{ "error": … }` today, `error: …`
    // text from a platform older than the ingress contract.
    readonly refusal: string | undefined;
    readonly body: string;
}

const answerOf = <K extends DaemonIngressRoute>(route: K, status: number, body: string): IngressAnswer<IngressOutput<K>> => {
    if (status < 200 || status >= 300) {
        return { status, data: undefined, refusal: ingressRefusalOf(body) ?? `the platform answered HTTP ${status}`, body };
    }
    const schema = (PLATFORM_INGRESS[route] as IngressRouteSpec).output;
    const parsed = schema?.safeParse(jsonOf(body));
    // SAFETY: the schema parsed is the route's own `output`, whose output IngressOutput<K> names.
    return { status, data: parsed?.success === true ? (parsed.data as IngressOutput<K>) : undefined, refusal: undefined, body };
};

// Calls one route and reads its answer, a refusal included; rejects only when the platform could not be reached, is
// not configured, or there is no credential to present.
export const callIngress = async <K extends DaemonIngressRoute>(config: Config, call: IngressCall<K>): Promise<IngressAnswer<IngressOutput<K>>> => {
    if (config.platform.url === "") {
        throw new Error("the platform URL is not configured for this sandbox");
    }
    const exchange = ingressExchange(config, call);
    if (exchange === undefined) {
        throw new Error("this sandbox holds no credential for that platform route");
    }
    const answer = await exchangeWithPlatform(config, exchange);
    return answerOf(call.route, answer.status, answer.body);
};

// A status is the platform's verdict, an error that it was unreachable; never rejects, since its callers retry.
export type PlatformReport = { readonly status: number } | { readonly error: string };

export const reportToPlatform = <K extends DaemonIngressRoute>(config: Config, route: K, input: IngressInput<K>): Promise<PlatformReport> =>
    callIngress(config, { route, input }).then(
        (answer): PlatformReport => ({ status: answer.status }),
        (error: unknown): PlatformReport => ({ error: errorMessage(error) }),
    );

// The owner's name for this sandbox and its switcher logo: held only by the platform, so a bundle must ask for them.
export interface SandboxPresentation {
    readonly name?: string;
    readonly image?: string;
}

// Best-effort, never a throw: an export must not fail because the platform is unreachable, headless or older.
export const fetchPresentation = async (config: Config): Promise<SandboxPresentation | undefined> => {
    try {
        const { data } = await callIngress(config, { route: "presentation" });
        if (data === undefined) {
            return undefined;
        }
        const { name, image } = data;
        const presentation: SandboxPresentation = {
            ...(name !== "" ? { name } : {}),
            ...(image !== undefined && image !== "" ? { image } : {}),
        };
        return presentation.name === undefined && presentation.image === undefined ? undefined : presentation;
    } catch {
        // allow(silent-catch): best-effort by contract, see above.
        return undefined;
    }
};
