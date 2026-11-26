import {
    extensionIdOf,
    PUBLIC_ROUTE_BODY_DEFAULT,
    PUBLIC_ROUTE_DAILY_DEFAULT,
    PUBLIC_ROUTE_NO_DAILY_MAX,
    PUBLIC_ROUTE_RATE_DEFAULT,
    PUBLIC_ROUTE_TURNSTILE_HEADER,
    publicRouteAutomationOf,
    publicRouteFor,
    type PublicRouteContribution,
} from "@intentic/extension-manifest";
import {
    PUBLIC_DOOR_CHALLENGE,
    PUBLIC_DOOR_CHALLENGE_PARAM,
    PUBLIC_DOOR_HEADER,
    PUBLIC_DOOR_KEY_PARAM,
    PUBLIC_DOOR_POW_CALLER_HEADER,
    PUBLIC_DOOR_POW_HEADER,
    type PublicDoorVerification,
} from "@intentic/sandbox-contract/extension-protocol";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { mintChallenge, proofOfWorkSolved, verifyTurnstile } from "../../auth/antibot.js";
import { bearerFrom } from "../../auth/auth.js";
import type { AutomationRecord } from "../../automations/automations-store.js";
import { type DoorAdmission, doorAdmission } from "../../automations/door-admission.js";
import { claimDelivery, deliverySeen } from "../../automations/durable/delivery-ledger.js";
import { deliveryIdOf, isPingDelivery, verifyWebhookSignature } from "../../automations/fire/webhook-signature.js";
import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../../composition.js";
import { readBoundedBytes } from "../../http/bounded-body.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { remoteIpOf } from "../../http/remote-ip.js";
import { opt } from "../../opt.js";
import { listenerOwnership } from "../listener/listener-state.js";
import { BACKEND_HOST_HEADER } from "./backend-host-config.js";
import { forwardToBackend } from "./backend-proxy.js";

// AN EXTENSION'S PUBLIC DOORS (2026-11-26): /door/<id>/<path>, anyone's to call, for the routes the extension's manifest
// declares (`contributes.publicRoutes`). The protections are the core's own public doors' (fire.routes.ts,
// webhook-signature.ts, and the Visitor chat's until it moved onto one of these on 2026-11-26), applied here from the
// declaration and cheapest first, so nothing reaches the backend that any of them refused:
//   the route (declared, method included) → the automation it names (this extension's own listener's, else 404), its
//   Origin against the automation's allowlist or its door key in place (and, where route and automation both say
//   `keyFromBrowsers`, the key for an unlisted browser too) (403), switched on (409) → the caller's minute
//   (429) → the body's size, counted as it arrives (413) → a solved proof of work (403) → the provider's signature over
//   the body with a sandbox secret the extension never sees (401), a ping answered and a redelivery of a call already
//   taken answered `duplicate` → a Cloudflare Turnstile token verified with a sandbox secret the extension never sees
//   (403, 2026-11-26; asked of Cloudflare, so after every check answered here) → the day's ceiling (429; none for a
//   GET-only route declaring `"none"`) → the delivery claimed, so two copies landing together reach it once →
//   forwarded with what was checked (PUBLIC_DOOR_HEADER), the key taken off and no credential carried.

// Every answer the door gives itself, before or instead of the backend's.
type DoorAnswer = { readonly error: string } | { readonly ok: true; readonly receipt: "ignored" | "duplicate" };
const json = (c: Context<AppEnv>, body: DoorAnswer, status: 200 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503) => c.json(body, status);

// The path's segments under /door/<id>/, decoded once; undefined for one that does not decode or that decodes to more
// than one segment, which no declared route names.
const segmentsOf = (pathname: string): { readonly extension: string; readonly rest: readonly string[] } | undefined => {
    const [, door, extension, ...rest] = pathname.split("/");
    if (door !== "door" || extension === undefined || extension === "") {
        return undefined;
    }
    try {
        const decoded = [extension, ...rest].map((segment) => decodeURIComponent(segment));
        if (decoded.some((segment) => segment.includes("/") || segment.includes("\\"))) {
            return undefined;
        }
        const [id = "", ...after] = decoded;
        return { extension: id, rest: after };
    } catch {
        // allow(silent-catch): a path that does not decode names no route, which the caller answers 404
        return undefined;
    }
};

// What the caller presented as the automation's door key: a bearer, or `?key=` for a caller that can only carry a URL.
const presentedKey = (c: Context<AppEnv>): string => {
    const bearer = bearerFrom(c.req.header("authorization"));
    return bearer === "" ? (c.req.query(PUBLIC_DOOR_KEY_PARAM) ?? "") : bearer;
};

// The automation an automation-scoped route names, admitted as the core's own public doors admit theirs: it listens on
// the provider this extension's listener owns; its Origin is on the automation's list or its door key stands in; and
// it is switched on, asked last so a site owner can tell a wrong origin from a switched-off door.
const automationDoor = async (
    services: Services,
    c: Context<AppEnv>,
    extension: InstalledExtension,
    route: PublicRouteContribution,
    automationId: string,
): Promise<Response | { readonly automation: AutomationRecord; readonly origin?: string; readonly keyed?: true }> => {
    const provider = extension.manifest.contributes?.listener?.provider;
    const automation = await services.automations.get(automationId);
    const owns = provider !== undefined && (await listenerOwnership(services)).owners.get(provider) === extension.id;
    if (!owns || automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== provider) {
        return json(c, { error: "no automation with that id behind this door" }, 404);
    }
    const admitted = await originAdmitted(services, c, route, automation);
    if (admitted instanceof Response) {
        return admitted;
    }
    if (!automation.enabled) {
        return json(c, { error: "this automation is switched off" }, 409);
    }
    return { automation, ...admitted };
};

// A listed route's gate: the browser's Origin on the automation's list, or, for a caller with no Origin at all (an app,
// a server), the automation's door key. A key stands in for a browser's Origin that is not listed only where the route
// declares `keyFromBrowsers` and the automation opts in (its trigger's `keyFromBrowsers`, 2026-11-26: the bug intake's
// setting of that name, honoured by its own door until it moved onto this one).
const originAdmitted = async (
    services: Services,
    c: Context<AppEnv>,
    route: PublicRouteContribution,
    automation: AutomationRecord,
): Promise<Response | { readonly origin?: string; readonly keyed?: true }> => {
    const origin = c.req.header("origin");
    if (route.origins !== "listed") {
        return opt("origin", origin);
    }
    const trigger = automation.trigger.kind === "listener" ? automation.trigger : undefined;
    if (origin !== undefined && (trigger?.allowedOrigins ?? []).includes(origin)) {
        return { origin };
    }
    const keyFromBrowsers = route.keyFromBrowsers === true && trigger?.keyFromBrowsers === true;
    if (origin !== undefined && !keyFromBrowsers) {
        return json(c, { error: "origin not allowed" }, 403);
    }
    const keyed = route.key === true && (await services.doorTokens.verify("intake", automation.id, presentedKey(c)));
    if (!keyed) {
        return json(c, { error: origin === undefined ? "this door needs a listed origin or its key" : "origin not allowed" }, 403);
    }
    return { keyed: true, ...opt("origin", origin) };
};

// The provider's signature over the body, with the route's sandbox secret: refused, answered without reaching the
// backend (a ping, a redelivery), or taken with the provider's id for the delivery.
type Signed = Response | { readonly scheme: NonNullable<PublicRouteContribution["signature"]>["scheme"]; readonly deliveryId?: string; readonly secret: string };

const checkSigned = async (
    services: Services,
    c: Context<AppEnv>,
    signature: NonNullable<PublicRouteContribution["signature"]>,
    ledger: string,
    body: Uint8Array,
    now: number,
): Promise<Signed> => {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
        return json(c, { error: "a signed call's body is UTF-8 text" }, 400);
    }
    const secret = await services.sandboxSecrets.get(signature.secret);
    if (secret === undefined || secret === "") {
        services.logger.warn({ door: ledger, secret: signature.secret }, "public door refused a call: its signing secret is not set");
        return json(c, { error: "unauthorized" }, 401);
    }
    const headers = c.req.raw.headers;
    const verified = verifyWebhookSignature(signature.scheme, secret, headers, text, now);
    if (!verified.ok) {
        return json(c, { error: verified.reason }, 401);
    }
    if (isPingDelivery(signature.scheme, headers)) {
        return json(c, { ok: true, receipt: "ignored" }, 200);
    }
    const deliveryId = deliveryIdOf(signature.scheme, headers, text);
    if (deliveryId !== undefined && (await deliverySeen(services, ledger, deliveryId, now))) {
        return json(c, { ok: true, receipt: "duplicate" }, 200);
    }
    return { scheme: signature.scheme, secret, ...opt("deliveryId", deliveryId) };
};

// A Cloudflare Turnstile token the caller sent, verified with Cloudflare under the route's sandbox secret, which the
// extension never sees. A secret not set refuses every call, as a signature's does, rather than letting the route stand
// open. (The Visitor chat checks its own: each chat holds its site's own secret, asked once per thread.)
const checkTurnstile = async (
    services: Services,
    c: Context<AppEnv>,
    turnstile: NonNullable<PublicRouteContribution["turnstile"]>,
    door: string,
    ip: string | undefined,
): Promise<Response | true> => {
    const token = c.req.header(PUBLIC_ROUTE_TURNSTILE_HEADER) ?? "";
    if (token === "") {
        return json(c, { error: "bot check failed" }, 403);
    }
    const secret = await services.sandboxSecrets.get(turnstile.secret);
    if (secret === undefined || secret === "") {
        services.logger.warn({ door, secret: turnstile.secret }, "public door refused a call: its Turnstile secret is not set");
        return json(c, { error: "bot check failed" }, 403);
    }
    try {
        return (await verifyTurnstile(secret, token, ip)) ? true : json(c, { error: "bot check failed" }, 403);
    } catch (error) {
        // Cloudflare not answering is no proof the caller is a person: refused, and said in the log for the owner.
        services.logger.warn({ door, err: error }, "public door refused a call: Cloudflare's Turnstile check did not answer");
        return json(c, { error: "bot check failed" }, 403);
    }
};

// The body handed on: what arrived, with a signing secret's own value masked wherever the sender put it in the text.
const handedOn = (body: Uint8Array, secret: string | undefined): Uint8Array<ArrayBuffer> | string => {
    if (secret === undefined || secret.length < 8) {
        return new Uint8Array(body);
    }
    return new TextDecoder().decode(body).replaceAll(secret, "[redacted]");
};

// A challenge for a caller of any route of this extension's that asks for proof of work; signed to that caller, nothing
// stored.
const challenge = (c: Context<AppEnv>, routes: readonly PublicRouteContribution[]): Response => {
    if (!routes.some((route) => route.proofOfWork === true)) {
        return json(c, { error: "no public route here asks for a challenge" }, 404);
    }
    const caller = c.req.query(PUBLIC_DOOR_CHALLENGE_PARAM) ?? "";
    if (caller === "") {
        return json(c, { error: `${PUBLIC_DOOR_CHALLENGE_PARAM} required` }, 400);
    }
    return c.json(mintChallenge(caller, Date.now()));
};

// The door's URL as the backend sees it: its path, and the query without the key.
const forwardedUrl = (c: Context<AppEnv>): URL => {
    const url = new URL(c.req.url);
    url.searchParams.delete(PUBLIC_DOOR_KEY_PARAM);
    return url;
};

const encodeVerification = (verification: PublicDoorVerification): string => Buffer.from(JSON.stringify(verification), "utf8").toString("base64url");

// Which declared route a request lands on, and the automation it names: a challenge, or a refusal, answered instead.
type Landed = {
    readonly extension: InstalledExtension;
    readonly route: PublicRouteContribution;
    readonly automationId?: string;
};

const landed = async (services: Services, c: Context<AppEnv>): Promise<Response | Landed> => {
    const where = segmentsOf(new URL(c.req.url).pathname);
    const extension = where === undefined ? undefined : (await cachedEnabledExtensions(services)).find((each) => each.id === where.extension);
    const routes = extension?.manifest.contributes?.publicRoutes ?? [];
    if (where === undefined || extension === undefined || routes.length === 0) {
        return json(c, { error: "no public route here" }, 404);
    }
    if (c.req.method === "GET" && where.rest.length === 1 && where.rest[0] === PUBLIC_DOOR_CHALLENGE) {
        return challenge(c, routes);
    }
    const route = publicRouteFor(routes, c.req.method, where.rest);
    if (route === undefined) {
        return json(c, { error: `no public route here answers ${c.req.method}` }, 404);
    }
    return { extension, route, ...opt("automationId", publicRouteAutomationOf(route, where.rest)) };
};

// What the door let through: the automation it is for, the body it read, and what the signature and proof of work said.
interface Admitted {
    readonly scoped?: Exclude<Awaited<ReturnType<typeof automationDoor>>, Response>;
    readonly door: string;
    readonly ip?: string;
    readonly body?: Uint8Array;
    readonly powCaller?: string;
    readonly signed?: Exclude<Signed, Response>;
    readonly turnstile?: true;
}

// The checks that need no body: the automation and its origin or key, then the caller's minute.
const admittedBeforeBody = async (
    services: Services,
    c: Context<AppEnv>,
    ceilings: DoorAdmission,
    { extension, route, automationId }: Landed,
    now: number,
): Promise<Response | Pick<Admitted, "scoped" | "door" | "ip">> => {
    const scoped = automationId === undefined ? undefined : await automationDoor(services, c, extension, route, automationId);
    if (scoped instanceof Response) {
        return scoped;
    }
    // Each door counts for itself: an automation's route per automation, every other route on its own.
    const door = `door:${extensionIdOf(extension.manifest)}/${route.path}${automationId === undefined ? "" : `/${automationId}`}`;
    const ip = remoteIpOf(c);
    if (ceilings.rateLimited(`${door}:${ip ?? "?"}`, route.rate ?? PUBLIC_ROUTE_RATE_DEFAULT, now)) {
        return json(c, { error: "rate limited" }, 429);
    }
    return { door, ...opt("scoped", scoped), ...opt("ip", ip) };
};

// The body, read within the route's ceiling, and the proof of work beside it.
const admittedBody = async (
    c: Context<AppEnv>,
    route: PublicRouteContribution,
    now: number,
): Promise<Response | Pick<Admitted, "body" | "powCaller">> => {
    const read = c.req.method === "GET" || c.req.method === "HEAD" ? undefined : await readBoundedBytes(c.req.raw, route.bodyMax ?? PUBLIC_ROUTE_BODY_DEFAULT);
    if (read !== undefined && read.kind !== "ok") {
        return json(c, { error: "payload too large" }, 413);
    }
    if (route.proofOfWork !== true) {
        return opt("body", read?.value);
    }
    const powCaller = c.req.header(PUBLIC_DOOR_POW_CALLER_HEADER) ?? "";
    const solved = powCaller !== "" && proofOfWorkSolved(c.req.header(PUBLIC_DOOR_POW_HEADER) ?? "", powCaller, now);
    return solved ? { powCaller, ...opt("body", read?.value) } : json(c, { error: "bot check failed" }, 403);
};

// Every check, cheapest first; the answer that refused, or what was let through.
const admitted = async (services: Services, c: Context<AppEnv>, ceilings: DoorAdmission, at: Landed, now: number): Promise<Response | Admitted> => {
    const before = await admittedBeforeBody(services, c, ceilings, at, now);
    if (before instanceof Response) {
        return before;
    }
    const { route } = at;
    const read = await admittedBody(c, route, now);
    if (read instanceof Response) {
        return read;
    }
    const signed = route.signature === undefined ? undefined : await checkSigned(services, c, route.signature, before.door, read.body ?? new Uint8Array(), now);
    if (signed instanceof Response) {
        return signed;
    }
    const human = route.turnstile === undefined ? undefined : await checkTurnstile(services, c, route.turnstile, before.door, before.ip);
    if (human instanceof Response) {
        return human;
    }
    // A GET-only route that only serves what a page loads may count no day (`"none"`); its minute and size still held.
    const dailyMax = route.dailyMax ?? PUBLIC_ROUTE_DAILY_DEFAULT;
    if (dailyMax !== PUBLIC_ROUTE_NO_DAILY_MAX && ceilings.overDailyCeiling(before.door, dailyMax, now)) {
        return json(c, { error: "this door has reached today's limit" }, 429);
    }
    // Claimed only once admitted, so a retry the ceilings turned away is still taken; inside one write, so two copies
    // landing together reach the backend once.
    if (signed?.deliveryId !== undefined && !(await claimDelivery(services, before.door, signed.deliveryId, now))) {
        return json(c, { ok: true, receipt: "duplicate" }, 200);
    }
    return { ...before, ...read, ...opt("signed", signed), ...opt("turnstile", human) };
};

// What the backend is told was checked.
const verificationOf = (c: Context<AppEnv>, route: PublicRouteContribution, passed: Admitted, now: number): PublicDoorVerification => ({
    route: route.path,
    at: now,
    ...opt("automationId", passed.scoped?.automation.id),
    ...opt("origin", passed.scoped === undefined ? c.req.header("origin") : passed.scoped.origin),
    ...opt("keyed", passed.scoped?.keyed),
    ...opt("signature", passed.signed === undefined ? undefined : { scheme: passed.signed.scheme, ...opt("deliveryId", passed.signed.deliveryId) }),
    ...opt("proofOfWork", passed.powCaller === undefined ? undefined : { caller: passed.powCaller }),
    ...opt("turnstile", passed.turnstile),
    ...opt("remoteIp", passed.ip),
});

export const createPublicDoorRoute = (services: Services) => {
    // One window and one day per daemon for every extension's doors, each keyed by its door, so no door spends another's.
    const ceilings = doorAdmission();
    return async (c: Context<AppEnv>): Promise<Response> => {
        const now = Date.now();
        const at = await landed(services, c);
        if (at instanceof Response) {
            return at;
        }
        const passed = await admitted(services, c, ceilings, at, now);
        if (passed instanceof Response) {
            return passed;
        }
        const target = services.extensionBackend.proxyTarget();
        if (target === undefined) {
            return json(c, { error: `extension backends are ${services.extensionBackend.status().state}` }, 503);
        }
        return forwardToBackend(
            c,
            {
                port: target.port,
                headers: { [BACKEND_HOST_HEADER]: target.hostToken, [PUBLIC_DOOR_HEADER]: encodeVerification(verificationOf(c, at.route, passed, now)) },
                body: passed.body === undefined ? undefined : handedOn(passed.body, passed.signed?.secret),
            },
            forwardedUrl(c),
            at.extension.id,
        );
    };
};

// Anyone's door into an extension's public routes, checked in the handler by the route's own declaration.
export const publicDoorRawRoutes = defineRawRoutes((services: Services) => ({ "ALL /door/*": createPublicDoorRoute(services) }));
