import { type ProjectResolveBody, ProjectResolvedSchema, RouteCandidatesSchema, type RouteResolveBody, RouteResolvedSchema } from "@intentic/api-contract/ingress";
import { parseJsonOr } from "@intentic/base/json";
import type { PassScope } from "@intentic/sandbox-contract/sandbox-pass";
import { z } from "zod";
import type { Config } from "../env.config.js";
import type { CliAnswer } from "../http/cli-answer.js";
import { callPlatform } from "../system/platform-relay.js";

/* WHERE A ROUTED REQUEST GOES (2026-11-24, docs/architecture/account-routing.md). The platform's directory is asked
 * `routeResolve` for one scope, as one person or (a report) nobody, and answers the target's address and a pass it signed.
 * - A pass is good for ten minutes, so an answer is kept per (scope, person, target) until a minute before it expires: an
 *   outbox draining twenty reports asks once.
 * - A pass the far side refuses (a 401 in its own words) is asked for again once: it expired early, or the claim moved.
 *   The bare `unauthorized` an older daemon gives every route it does not know is not that, and asking again cannot help.
 * - Several sandboxes the person reaches claiming one project answer 409 with candidates: a refusal naming them, for the
 *   sender to pick one by name.
 * - A platform from before `routeResolve` answers 404 for the route itself; a report then asks `projectResolve`, which is
 *   what reports always asked. No other scope existed there, so nothing else falls back. */

// What a send is routed for: the scope, the one person it goes as, and the target (a report's project, else a sandbox).
export interface RouteRequest {
    readonly scope: PassScope;
    readonly person?: string | undefined;
    readonly project?: string | undefined;
    readonly sandbox?: string | undefined;
}

// Where the platform says to send it, and the pass to show there.
export interface RouteTarget {
    readonly sandboxId: string;
    readonly name: string;
    readonly address: string;
    readonly pass: string;
    readonly expiresAt: string;
    readonly project?: string | undefined;
    readonly crossesOrg?: z.infer<typeof RouteResolvedSchema>["crossesOrg"];
}

export interface RouteCandidate {
    readonly sandboxId: string;
    readonly name: string;
}

// The platform's answer, or why there is none: `status` 0 for a platform that could not be reached.
export type RouteAnswer =
    | { readonly ok: true; readonly value: RouteTarget }
    | { readonly ok: false; readonly status: number; readonly message: string; readonly candidates?: readonly RouteCandidate[] };

// One try at the far side: its answer, or `status` 0 for none at all.
export interface Delivery {
    readonly status: number;
    readonly error?: string | undefined;
    readonly id?: string | undefined;
    // The far side's word for why it refused (admit-route.ts RouteRefusalCode): `pairing` is the person's to allow.
    readonly code?: string | undefined;
    // Taken by this sandbox's messages outbox rather than the far side (account-routing/messages/report-over-s2s.ts), which keeps
    // trying it: why it has not landed yet.
    readonly handedOn?: string | undefined;
}

// A daemon older than a door refuses it as a sign-in it does not know: the bare "unauthorized" every unknown route gets,
// where a door words its own refusals (the same tell link-client.ts reads).
export const tooOld = (delivery: Delivery): boolean => delivery.status === 401 && delivery.error === "unauthorized";

// How long before a pass expires it stops being handed out from the cache.
const ROUTE_CACHE_MARGIN_MS = 60_000;

export type PlatformRouteCall =
    | { readonly route: "routeResolve"; readonly input: RouteResolveBody }
    | { readonly route: "projectResolve"; readonly input: ProjectResolveBody };

export interface RouteClientDeps {
    // One platform call: routeResolve, or projectResolve for an older platform.
    readonly call: (call: PlatformRouteCall) => Promise<CliAnswer>;
    readonly now?: () => number;
}

const ErrorBodySchema = z.object({ error: z.string() });

const keyOf = (request: RouteRequest): string =>
    [request.scope, request.person?.toLowerCase() ?? "", request.project ?? "", request.sandbox ?? ""].join("\u0000");

const inputOf = (request: RouteRequest): RouteResolveBody => {
    const input: RouteResolveBody = { scope: request.scope };
    if (request.person !== undefined) {
        input.person = request.person;
    }
    if (request.project !== undefined) {
        input.project = request.project;
    }
    if (request.sandbox !== undefined) {
        input.sandbox = request.sandbox;
    }
    return input;
};

// A refusal as the platform worded it; `status` 0 for one it relayed as unreachable (502 from the relay itself).
const refusalOf = (answer: CliAnswer): RouteAnswer => {
    const parsed = parseJsonOr(answer.body, undefined);
    const candidates = answer.status === 409 ? RouteCandidatesSchema.safeParse(parsed) : undefined;
    if (candidates?.success === true) {
        const names = candidates.data.candidates.map((candidate) => `${candidate.name} (${candidate.sandboxId})`).join(", ");
        return { ok: false, status: 409, message: `${candidates.data.error}: ${names}`, candidates: candidates.data.candidates };
    }
    const error = ErrorBodySchema.safeParse(parsed).data?.error;
    return { ok: false, status: answer.status === 502 ? 0 : answer.status, message: error ?? `the platform answered ${answer.status}` };
};

const UNREADABLE_ANSWER = "the platform answered in a shape this build does not read";

export const createRouteClient = (deps: RouteClientDeps) => {
    const now = deps.now ?? Date.now;
    const cache = new Map<string, { readonly value: RouteTarget; readonly until: number }>();

    // A report through the older directory, for a platform that does not serve routeResolve.
    const viaProjects = async (request: RouteRequest): Promise<RouteAnswer> => {
        const answer = await deps.call({ route: "projectResolve", input: { project: request.project ?? "" } });
        if (answer.status !== 200) {
            return refusalOf(answer);
        }
        const value = ProjectResolvedSchema.safeParse(parseJsonOr(answer.body, undefined));
        return value.success ? { ok: true, value: value.data } : { ok: false, status: 502, message: UNREADABLE_ANSWER };
    };

    const ask = async (request: RouteRequest): Promise<RouteAnswer> => {
        const answer = await deps.call({ route: "routeResolve", input: inputOf(request) });
        const parsed = parseJsonOr(answer.body, undefined);
        // The handler words its own 404 (no claim, no such sandbox); the route missing altogether is the older platform.
        if (answer.status === 404 && !ErrorBodySchema.safeParse(parsed).success) {
            return request.scope === "report" && request.project !== undefined
                ? viaProjects(request)
                : { ok: false, status: 404, message: "the platform is too old to route as a person: only reports go until it is updated" };
        }
        if (answer.status !== 200) {
            return refusalOf(answer);
        }
        const value = RouteResolvedSchema.safeParse(parsed);
        if (!value.success) {
            return { ok: false, status: 502, message: UNREADABLE_ANSWER };
        }
        const { scope: _scope, ...target } = value.data;
        return { ok: true, value: target };
    };

    /** Where a request goes, from the cache while its pass has more than a minute left; `fresh` asks again. */
    const routeTo = async (request: RouteRequest, options: { readonly fresh?: boolean } = {}): Promise<RouteAnswer> => {
        const key = keyOf(request);
        const kept = cache.get(key);
        if (options.fresh !== true && kept !== undefined && kept.until > now()) {
            return { ok: true, value: kept.value };
        }
        cache.delete(key);
        const answer = await ask(request);
        if (answer.ok) {
            const until = Date.parse(answer.value.expiresAt) - ROUTE_CACHE_MARGIN_MS;
            if (Number.isFinite(until) && until > now()) {
                cache.set(key, { value: answer.value, until });
            }
        }
        return answer;
    };

    /**
     * Routes a request and hands it to `send`, asking for a new pass once when the far side refuses the one it got. The
     * answer is the platform's refusal, or the last try with the target it went to.
     */
    const deliverRouted = async (
        request: RouteRequest,
        send: (target: RouteTarget) => Promise<Delivery>,
    ): Promise<{ readonly routed: false; readonly answer: Extract<RouteAnswer, { ok: false }> } | { readonly routed: true; readonly target: RouteTarget; readonly delivery: Delivery }> => {
        let fresh = false;
        for (;;) {
            const answer = await routeTo(request, { fresh });
            if (!answer.ok) {
                return { routed: false, answer };
            }
            const delivery = await send(answer.value);
            if (fresh || delivery.status !== 401 || tooOld(delivery)) {
                return { routed: true, target: answer.value, delivery };
            }
            fresh = true;
        }
    };

    return { routeTo, deliverRouted };
};

export type RouteClient = ReturnType<typeof createRouteClient>;

// The platform's directory, through the relay every connect-token route uses.
const platformRouteCall =
    (config: Config): RouteClientDeps["call"] =>
    (call) =>
        call.route === "routeResolve"
            ? callPlatform(config, { route: call.route, input: call.input, unreached: "nothing was sent" })
            : callPlatform(config, { route: call.route, input: call.input, unreached: "nothing was sent" });

// One client per daemon (keyed by its config, the one object every caller holds), so every sender shares its cache of passes.
// allow(module-state): one route client per daemon's services, shared by the outbox and every routed send.
const clients = new WeakMap<Config, RouteClient>();

export const routeClientOf = (services: { readonly config: Config }): RouteClient => {
    const known = clients.get(services.config);
    if (known !== undefined) {
        return known;
    }
    const client = createRouteClient({ call: platformRouteCall(services.config) });
    clients.set(services.config, client);
    return client;
};
