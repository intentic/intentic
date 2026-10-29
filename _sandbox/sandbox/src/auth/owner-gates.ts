import { holdsRight, type ManageRight } from "@intentic/sandbox-contract/schemas/members";
import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { ManifestUnreadableError } from "../store/json-file.js";
import { authorizeMaintainer, bearerFrom, type Caller, ForbiddenError } from "./auth.js";
import { type Listener, listenerIn, listenerOf } from "./proofs/listener.js";

/* The answers a privileged route asks for before it does anything, as a plain-Hono refusal and as an oRPC one, plus
 * whether the bearer holds an answer for a route that refuses nobody and only turns on it, and the answer a plain
 * route gives when the credential store it writes cannot be read. Each gate reads the bearer alone, so a request a
 * machine credential admitted (panel, agent, extension or control token) never passes.
 *
 * `ownerDenied` is the operating gate, whatever its name says: a maintainer (Full access) is deliberately
 * owner-equivalent here. A part of the sandbox that can also be handed to someone below it (sandbox-contract
 * `ManageRightSchema`: people, secrets, privacy, AI accounts of one's own) asks `rightDenied` / `ensureRight`, which admit
 * the owner, Full access, and whoever was given that part. Ownership itself (`ownershipDenied`, `ensureOwner`) is left
 * for what is the owner's personally: the platform's record of the sandbox, the owner's own sign-in door, and the owner's
 * own computers. */

type AuthDeps = Pick<Services, "auth">;
type Auth = NonNullable<Services["auth"]>;

// The bearer, and the way the request came in that a channel-bound proof is checked against (listener.ts), with the
// tier the check holds it to: named in the refusal (`floor`), as the role floor names its own, so the editor reads
// which tier was wanted instead of matching the sentence.
interface Check {
    readonly floor: "maintainer" | "owner";
    readonly run: (auth: Auth, bearer: string, listener: Listener) => Promise<void>;
}
const maintainer: Check = { floor: "maintainer", run: authorizeMaintainer };
const owner: Check = { floor: "owner", run: (auth, bearer, listener) => auth.authorizeOwner(bearer, listener) };
// The owner, Full access, or a member given this part of the sandbox: floored at maintainer, as the route declares it.
const given = (right: ManageRight): Check => ({
    floor: "maintainer",
    run: async (auth, bearer, listener) => {
        const caller = await auth.authorize(bearer, undefined, { listener });
        if (!holdsRight(caller, right)) {
            throw new ForbiddenError(`not given ${right} on this sandbox`);
        }
    },
});

const bearerOf = (headers: Headers): string => bearerFrom(headers.get("authorization") ?? undefined);

// A plain route's refusal: 403 with the reason for a known caller below the tier, 401 for anything else.
const denied = async (services: AuthDeps, c: Context, check: Check): Promise<Response | undefined> => {
    if (services.auth === undefined) {
        return undefined;
    }
    try {
        await check.run(services.auth, bearerFrom(c.req.header("authorization")), listenerOf((name) => c.req.header(name)));
        return undefined;
    } catch (error) {
        return error instanceof ForbiddenError ? c.json({ error: error.message, floor: check.floor }, 403) : c.json({ error: "unauthorized" }, 401);
    }
};

export const ownerDenied = (services: AuthDeps, c: Context): Promise<Response | undefined> => denied(services, c, maintainer);

export const ownershipDenied = (services: AuthDeps, c: Context): Promise<Response | undefined> => denied(services, c, owner);

export const rightDenied = (services: AuthDeps, c: Context, right: ManageRight): Promise<Response | undefined> => denied(services, c, given(right));

// Throws the refusal an oRPC handler sends to anyone below the maintainer tier.
export const requireMaintainer = async (services: AuthDeps, headers: Headers, refusal: string): Promise<void> => {
    if (services.auth === undefined) {
        return;
    }
    try {
        await authorizeMaintainer(services.auth, bearerOf(headers), listenerIn(headers));
    } catch {
        throw new ORPCError("FORBIDDEN", { message: refusal, data: { floor: maintainer.floor } });
    }
};

// The oRPC form of `denied`: FORBIDDEN with the reason for a known caller below the tier, UNAUTHORIZED for anything else.
const refused = async (services: AuthDeps, headers: Headers, check: Check): Promise<void> => {
    if (services.auth === undefined) {
        return;
    }
    try {
        await check.run(services.auth, bearerOf(headers), listenerIn(headers));
    } catch (error) {
        if (error instanceof ForbiddenError) {
            throw new ORPCError("FORBIDDEN", { message: error.message, data: { floor: check.floor } });
        }
        throw new ORPCError("UNAUTHORIZED");
    }
};

// Throws unless the bearer is the owner, saying which refusal it is.
export const ensureOwner = (services: AuthDeps, headers: Headers): Promise<void> => refused(services, headers, owner);

// Throws unless the bearer runs this part of the sandbox: the owner, Full access, or someone given it.
export const ensureRight = (services: AuthDeps, headers: Headers, right: ManageRight): Promise<void> => refused(services, headers, given(right));

// Whether this bearer runs this part of the sandbox, refusing nobody: for a route where only some changes turn on the
// answer (loosening a secret's guard). A loopback daemon has one person, who is the owner. A machine credential never
// passes, whoever's session it rides.
export const holdsRightBearer = async (services: AuthDeps, headers: Headers, right: ManageRight): Promise<boolean> => {
    if (services.auth === undefined) {
        return true;
    }
    return services.auth.authorize(bearerOf(headers), undefined, { listener: listenerIn(headers) }).then(
        (caller: Caller) => holdsRight(caller, right),
        () => false,
    );
};

// Whether this bearer is the owner, refusing nobody: for a route where only some changes turn on the answer. A
// loopback daemon has one person, who is the owner.
export const isOwnerBearer = async (services: AuthDeps, headers: Headers): Promise<boolean> => {
    if (services.auth === undefined) {
        return true;
    }
    return services.auth.authorizeOwner(bearerOf(headers), listenerIn(headers)).then(
        () => true,
        () => false,
    );
};

// A credential store this build cannot read refuses a write rather than replacing what it holds (`onUnreadable:
// "refuse"`, store/json-file.ts). That is this sandbox's to fix, not the caller's: 503 naming the file, the answer the
// doors give a store they cannot read, rather than a 500.
export const unavailableIfUnreadable = async (c: Context, answer: () => Promise<Response>): Promise<Response> => {
    try {
        return await answer();
    } catch (error) {
        if (error instanceof ManifestUnreadableError) {
            return c.json({ error: error.message }, 503);
        }
        throw error;
    }
};
