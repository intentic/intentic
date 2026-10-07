import { ORPCError } from "@orpc/server";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { ManifestUnreadableError } from "../store/json-file.js";
import { authorizeMaintainer, bearerFrom, ForbiddenError } from "./auth.js";

/* The two answers a privileged route asks for before it does anything, as a plain-Hono refusal and as an oRPC one, plus
 * whether the bearer is the owner for a route that refuses nobody and only turns on the answer, and the answer a plain
 * route gives when the credential store it writes cannot be read. Each gate reads the bearer alone, so a request a
 * machine credential admitted (panel, agent, extension or control token) never passes.
 *
 * `ownerDenied` is the operating gate, whatever its name says: a maintainer is deliberately owner-equivalent here.
 * Ownership itself is kept separate, in `ownershipDenied`, for the one thing a revokable grant cannot control:
 * membership. */

type AuthDeps = Pick<Services, "auth">;
type Auth = NonNullable<Services["auth"]>;

type Check = (auth: Auth, bearer: string) => Promise<void>;
const maintainer: Check = authorizeMaintainer;
const owner: Check = (auth, bearer) => auth.authorizeOwner(bearer);

const bearerOf = (headers: Headers): string => bearerFrom(headers.get("authorization") ?? undefined);

// A plain route's refusal: 403 with the reason for a known caller below the tier, 401 for anything else.
const denied = async (services: AuthDeps, c: Context, check: Check): Promise<Response | undefined> => {
    if (services.auth === undefined) {
        return undefined;
    }
    try {
        await check(services.auth, bearerFrom(c.req.header("authorization")));
        return undefined;
    } catch (error) {
        return error instanceof ForbiddenError ? c.json({ error: error.message }, 403) : c.json({ error: "unauthorized" }, 401);
    }
};

export const ownerDenied = (services: AuthDeps, c: Context): Promise<Response | undefined> => denied(services, c, maintainer);

export const ownershipDenied = (services: AuthDeps, c: Context): Promise<Response | undefined> => denied(services, c, owner);

// Throws the refusal an oRPC handler sends to anyone below the maintainer tier.
export const requireMaintainer = async (services: AuthDeps, headers: Headers, refusal: string): Promise<void> => {
    if (services.auth === undefined) {
        return;
    }
    try {
        await authorizeMaintainer(services.auth, bearerOf(headers));
    } catch {
        throw new ORPCError("FORBIDDEN", { message: refusal });
    }
};

// The oRPC form of `denied`: FORBIDDEN with the reason for a known caller below the tier, UNAUTHORIZED for anything else.
const refused = async (services: AuthDeps, headers: Headers, check: Check): Promise<void> => {
    if (services.auth === undefined) {
        return;
    }
    try {
        await check(services.auth, bearerOf(headers));
    } catch (error) {
        if (error instanceof ForbiddenError) {
            throw new ORPCError("FORBIDDEN", { message: error.message });
        }
        throw new ORPCError("UNAUTHORIZED");
    }
};

// Throws unless the bearer holds the operating tier (the owner or a maintainer), saying which refusal it is.
export const ensureMaintainer = (services: AuthDeps, headers: Headers): Promise<void> => refused(services, headers, maintainer);

// Throws unless the bearer is the owner, saying which refusal it is.
export const ensureOwner = (services: AuthDeps, headers: Headers): Promise<void> => refused(services, headers, owner);

// Whether this bearer is the owner, refusing nobody: for a route where only some changes turn on the answer. A
// loopback daemon has one person, who is the owner.
export const isOwnerBearer = async (services: AuthDeps, headers: Headers): Promise<boolean> => {
    if (services.auth === undefined) {
        return true;
    }
    return services.auth.authorizeOwner(bearerOf(headers)).then(
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
