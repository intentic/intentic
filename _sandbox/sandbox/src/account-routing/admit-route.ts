import { scopeRefusal } from "@intentic/sandbox-contract/protocol/member-reach";
import { type PassScope, ROUTE_SECRET_HEADER, SANDBOX_PASS_HEADER, type SandboxPass, verifySandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Caller } from "../auth/auth.js";
import { rosterReader } from "../auth/members/member-caller.js";
import type { Services } from "../composition.js";
import { filePairingsStore, type PairingsStore } from "./pairings-store.js";

/* ADMISSION AT EVERY PASS-ADMITTED `/account/*` DOOR (2026-11-24, docs/architecture/account-routing.md). In order, so a
 * refusal costs as little as the earliest gate that can say no:
 * 1. the pass: signed by the platform's key (waited for briefly on a sandbox that has not announced yet), addressed to this
 *    sandbox, for this door's scope;
 * 2. the sender's minute for that scope: one runaway sandbox buys a minute of one kind of request here, and a sender
 *    guessing pairing secrets buys a handful of guesses;
 * 3. a report: its person is attribution only, kept when the roster here knows them and dropped otherwise;
 * 4. any other scope, the person as this sandbox sees them: on the roster now (`callerOf`, so a removal takes at once),
 *    above the scope's floor (member-reach.ts scopeRefusal, the editor's forecast of the same answer), and holding the
 *    pairing secret they minted here for the sender (pairings-store.ts), compared in constant time. The platform's word
 *    alone opens nothing but an inbox.
 * Each refusal says what to do in words an agent can act on, with a `code` the sending side branches on: `pairing` is the
 * one it turns into the person's `route` card (needs/kinds/route-need.ts). */

// How long to wait for the platform's key on a sandbox that has not announced yet, before refusing as "try again".
const KEY_WAIT_MS = 3_000;

// Per sending sandbox and scope, a minute.
export const ROUTE_PER_MINUTE = { report: 30, drop: 30, read: 120, task: 10 } as const satisfies Readonly<Record<PassScope, number>>;

export type RouteRefusalCode = "unready" | "pass" | "rate" | "not_member" | "floor" | "pairing";

// Who got in: the pass, and the person as this sandbox's roster admits them (on a report, only when it knows them).
export interface RouteAdmitted {
    readonly pass: SandboxPass;
    readonly person?: Caller;
}

export interface RouteAdmissionDeps {
    readonly identityKey: (waitMs: number) => Promise<string | undefined>;
    // This sandbox's tunnel id.
    readonly self: string | undefined;
    readonly roster: () => Promise<{ readonly callerOf: (email: string) => Caller | undefined }>;
    readonly pairings: () => PairingsStore;
    readonly now?: () => number;
}

export interface AdmitOptions {
    readonly wake?: boolean;
    readonly upgraded?: boolean;
}

// A sliding minute per key, in memory: a restart forgets it, which costs at most one more minute.
const minuteLimiter = (now: () => number) => {
    const minute = new Map<string, number[]>();
    return (key: string, max: number): boolean => {
        const at = now();
        const recent = (minute.get(key) ?? []).filter((stamp) => at - stamp < 60_000);
        const limited = recent.length >= max;
        if (!limited) {
            recent.push(at);
        }
        minute.set(key, recent);
        return limited;
    };
};

const refuse = (c: Context<AppEnv>, status: 401 | 403 | 429 | 503, code: RouteRefusalCode, error: string): Response => c.json({ error, code }, status);

export const createRouteAdmission = (deps: RouteAdmissionDeps) => {
    const now = deps.now ?? Date.now;
    const limited = minuteLimiter(now);

    /**
     * Admits a request at a door of `scope`, or answers the refusal. `wake` is a drop that asks to start a turn;
     * `upgraded` is the pairing upgrade's own door, where a pairing already upgraded still answers its repeat.
     */
    const admitRoute = async (c: Context<AppEnv>, scope: PassScope, options: AdmitOptions = {}): Promise<RouteAdmitted | Response> => {
        const key = await deps.identityKey(KEY_WAIT_MS);
        if (key === undefined || deps.self === undefined) {
            return refuse(c, 503, "unready", "this sandbox has not heard from the platform yet, so it cannot check a pass: try again shortly");
        }
        const pass = verifySandboxPass(key, c.req.header(SANDBOX_PASS_HEADER) ?? "", now());
        if (pass?.to !== deps.self || pass.scope !== scope) {
            return refuse(c, 401, "pass", "this pass is not one the platform signed for this sandbox and this door, or it has expired: resolve it again");
        }
        if (limited(`${pass.from}\u0000${scope}`, ROUTE_PER_MINUTE[scope])) {
            return refuse(c, 429, "rate", `rate limited: too many ${scope} requests from your sandbox this minute`);
        }
        if (scope === "report") {
            const known = pass.person === undefined ? undefined : (await deps.roster()).callerOf(pass.person);
            return known === undefined ? { pass } : { pass, person: known };
        }
        return admitPerson(c, pass, scope, options);
    };

    // The person a non-report pass routes as, as this sandbox admits them.
    const admitPerson = async (c: Context<AppEnv>, pass: SandboxPass, scope: PassScope, options: AdmitOptions): Promise<RouteAdmitted | Response> => {
        const email = pass.person ?? "";
        const person = email === "" ? undefined : (await deps.roster()).callerOf(email);
        if (person === undefined) {
            return refuse(c, 403, "not_member", `${email || "the person this pass names"} is not a member of this sandbox: its owner can invite them`);
        }
        const below = scopeRefusal(person, scope, options);
        if (below !== undefined) {
            return refuse(c, 403, "floor", `${email} may not ${scope} here: ${below.error}`);
        }
        const upgraded = options.upgraded === true ? { upgraded: now() } : undefined;
        if (!(await deps.pairings().verify(pass.from, email, c.req.header(ROUTE_SECRET_HEADER), upgraded))) {
            return refuse(
                c,
                403,
                "pairing",
                `${email} has not allowed ${pass.fromName} to ${scope} here as them, or took it back: they allow it on the card ${pass.fromName} raises, signed in to both sandboxes`,
            );
        }
        return { pass, person };
    };

    return admitRoute;
};

export type AdmitRoute = ReturnType<typeof createRouteAdmission>;

// One admission per daemon, so every door shares the per-scope minute.
// allow(module-state): one admission per daemon's services, shared by every pass-admitted door.
const admissions = new WeakMap<Services, AdmitRoute>();

/** This daemon's admission, for every pass-admitted `/account/*` door. */
export const routeAdmissionOf = (services: Services): AdmitRoute => {
    const known = admissions.get(services);
    if (known !== undefined) {
        return known;
    }
    const admit = createRouteAdmission({
        identityKey: (waitMs) => services.platformIdentityKey.settled(waitMs),
        self: sandboxIdFromToken(services.config.connectToken),
        roster: rosterReader(() => services),
        pairings: () => filePairingsStore(services.config.historyRoot),
    });
    admissions.set(services, admit);
    return admit;
};
