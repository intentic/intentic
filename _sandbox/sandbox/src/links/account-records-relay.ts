import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import type { DiagnosticsQuery } from "@intentic/sandbox-contract/schemas/diagnostics";
import { ROUTE_SECRET_HEADER, SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import { parseJsonOr } from "@intentic/base/json";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app-env.js";
import { forgetPairing, requirePairing } from "../account-routing/require-pairing.js";
import { type Delivery, routeClientOf, type RouteTarget, tooOld } from "../account-routing/route-client.js";
import type { Services } from "../composition.js";
import { routeCallerOf } from "./route-caller.js";

// THE ASKING SIDE OF A READ AS A PERSON (2026-11-24, docs/architecture/account-routing.md): `agents ls|find|show|bundle
// --on <sandbox>` and `diagnostics … --on <sandbox>` when no link card has that name. The read goes as the one person the
// proven conversation acts for, into a sandbox that person is in: the platform says where it is and signs a read pass,
// and the person's pairing rides beside it (a missing one raises their `route` card and reads nothing). What may be read
// over there is that sandbox's word (account-routing/read.routes.ts), cut to what the person may read there.

export type RoutedReadDeps = Pick<Services, "agents" | "conversations" | "ownerEmail" | "config" | "workspace" | "needs" | "s2s">;

const ASK_MS = 30_000;

const FarBodySchema = z.looseObject({ error: z.string().optional(), message: z.string().optional(), code: z.string().optional() });

interface FarAnswer {
    readonly status: number;
    readonly text: string;
}

// One request to the far door under the pass and the pairing; a redirect is refused, so the pass goes nowhere else.
const askDoor = async (target: RouteTarget, secret: string, path: string, query: DiagnosticsQuery | undefined): Promise<FarAnswer> => {
    const passHeaders = { [SANDBOX_PASS_HEADER]: target.pass, [ROUTE_SECRET_HEADER]: secret };
    const init: RequestInit =
        query === undefined
            ? { method: "GET", headers: passHeaders }
            : { method: "POST", headers: { ...passHeaders, "content-type": "application/json" }, body: JSON.stringify(query) };
    try {
        const response = await fetch(new URL(path, target.address), { ...init, redirect: "error", signal: AbortSignal.timeout(ASK_MS) });
        return { status: response.status, text: await response.text() };
    } catch {
        // allow(silent-catch): a sandbox that does not answer is said as status 0.
        return { status: 0, text: "" };
    }
};

const deliveryOf = (answer: FarAnswer): Delivery => {
    const body = FarBodySchema.safeParse(parseJsonOr(answer.text, undefined)).data;
    return { status: answer.status, error: body?.error ?? body?.message, code: body?.code };
};

// A JSON answer at whatever status it came with.
const refusal = (message: string, status: number): Response =>
    new Response(JSON.stringify({ ok: false, message }), { status, headers: { "content-type": "application/json" } });

// The far answer as the agent's commands read it: a refusal worded as `error` there becomes the `message` they print.
const relayed = (sandbox: string, answer: FarAnswer, delivery: Delivery): Response => {
    if (answer.status === 0) {
        return refusal(`"${sandbox}" did not answer: it may be asleep or offline.`, 502);
    }
    if (tooOld(delivery)) {
        return refusal(`"${sandbox}" runs a build too old to be read as a person: updating that sandbox brings it.`, 502);
    }
    if (answer.status >= 400) {
        return refusal(`"${sandbox}": ${delivery.error ?? `it answered ${answer.status}`}`, answer.status);
    }
    return new Response(answer.text, { status: answer.status, headers: { "content-type": "application/json" } });
};

/** A read routed as the asking conversation's person into `sandbox`, at the far `path` (a GET, or a POST of a diagnostics query). */
const routedRead = async (deps: RoutedReadDeps, c: Context<AppEnv>, ask: RoutedAsk, path: string, query?: DiagnosticsQuery): Promise<Response> => {
    const { sandbox, unlinked } = ask;
    const caller = await routeCallerOf(deps, c);
    if (caller.refused !== undefined) {
        return refusal(caller.refused, 403);
    }
    const { person, conversationId } = caller;
    if (person === undefined || conversationId === undefined) {
        return refusal(
            `${unlinked} Nor can this shell read it as a person: only a turn acting for one person reads another sandbox they are in.`,
            404,
        );
    }
    let last: FarAnswer = { status: 0, text: "" };
    const routed = await routeClientOf(deps).deliverRouted({ scope: "read", person, sandbox }, async (target) => {
        const pairing = await requirePairing(deps, { conversationId, target, person, scopes: ["read"] });
        if (!("secret" in pairing)) {
            last = { status: 403, text: JSON.stringify({ error: "asked" in pairing ? pairing.asked : pairing.refused, code: "asked" }) };
            return deliveryOf(last);
        }
        last = await askDoor(target, pairing.secret, path, query);
        return deliveryOf(last);
    });
    if (!routed.routed) {
        return refusal(
            `${unlinked} Read as ${person}, the platform could not route it either: ${routed.answer.message}.`,
            routed.answer.status === 0 ? 502 : 404,
        );
    }
    if (routed.delivery.code === "asked") {
        return refusal(routed.delivery.error ?? "", 403);
    }
    if (routed.delivery.code === "pairing") {
        // They took it back over there: forget it here, so the next read asks them again on a card.
        await forgetPairing(deps, routed.target.sandboxId, person);
    }
    return relayed(routed.target.name, last, routed.delivery);
};

// The sandbox a read names, and what the link side said of it (no card by that name), which a read that cannot go as a
// person answers with.
export interface RoutedAsk {
    readonly sandbox: string;
    readonly unlinked: string;
}

/** A fleet read (`GET /fleet…?on=<sandbox>`) routed as the person. */
export const routedFleetRead = (deps: RoutedReadDeps, c: Context<AppEnv>, ask: RoutedAsk): Promise<Response> => {
    const url = new URL(c.req.url);
    url.searchParams.delete("on");
    const query = url.searchParams.toString();
    const rest = url.pathname.replace(/^\/fleet/u, "");
    return routedRead(deps, c, ask, `${rawRouteUrl("GET /account/read/agents")}${rest}${query === "" ? "" : `?${query}`}`);
};

/** A diagnostics query (`diagnostics … --on <sandbox>`) routed as the person. */
export const routedDiagnostics = (deps: RoutedReadDeps, c: Context<AppEnv>, ask: RoutedAsk, query: DiagnosticsQuery): Promise<Response> =>
    routedRead(deps, c, ask, rawRouteUrl("POST /account/read/diagnostics"), query);
