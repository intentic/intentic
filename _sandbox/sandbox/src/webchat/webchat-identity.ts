import type { WebchatConfig, WebchatMessage } from "@intentic/sandbox-contract";
import { createGoogleVerifier, fileOwnerStore, type IdTokenVerifier } from "../auth/auth.js";
import type { Services } from "../composition.js";
import { statePath } from "../workspace/state-paths.js";

/* Who the daemon tells the model it is talking to.
 *
 * The distinction this module exists to keep is between a name someone TYPED and a name Google SIGNED. Both
 * end up in the prompt, and a public chat is exactly the place where an anonymous visitor calling themselves
 * "admin (owner)" must not read like the owner — so they travel in separate fields, and only one of them is
 * ever produced by verifying a signature. */

export interface VisitorIdentity {
    // What the fleet board and the activity feed call this visitor. Derived, never taken from the client.
    readonly author: string;
    // Present only when a Google ID token verified against the site's own client id.
    readonly verified?: { email: string; name?: string };
    // The typed name, carried separately and always labelled unverified where the model can see it.
    readonly displayName?: string;
    // The verified email is the sandbox's owner or one of its members — the person can already open this
    // sandbox in a browser. A CLAIM on the message, not a grant: it buys nothing but a different prompt.
    readonly member?: boolean;
}

export class SignInRequired extends Error {}

/* One verifier per client id, kept for the life of the daemon. `createGoogleVerifier` builds a remote JWKS
 * whose whole value is its key cache — rebuilding it per message would fetch Google's certs on every visitor
 * message and turn a signature check into a network round trip. Keyed by client id because a sandbox can serve
 * several sites, each with its own OAuth client. */
const verifiers = new Map<string, IdTokenVerifier>();

const verifierFor = (clientId: string): IdTokenVerifier => {
    const existing = verifiers.get(clientId);
    if (existing !== undefined) {
        return existing;
    }
    const verifier = createGoogleVerifier(clientId);
    verifiers.set(clientId, verifier);
    return verifier;
};

// The emails that can already reach this sandbox: its owner plus every member. Read per message rather than
// cached — the set changes from the Members UI, and a stale "member" tag is a lie about who is talking.
const authorizedEmails = async (services: Pick<Services, "workspace" | "members">): Promise<Set<string>> => {
    const owner = await fileOwnerStore(statePath(services.workspace.root, ".intentic/owner.json")).read();
    const members = await services.members.list();
    return new Set([...(owner === undefined ? [] : [owner]), ...members].map((email) => email.toLowerCase()));
};

/* Resolve one message's sender. Throws SignInRequired when the Doorbell is sign-in-only and the token is
 * absent or bad — the route answers 401, and the widget re-opens its sign-in gate.
 *
 * A verification failure is deliberately NOT distinguished from a missing token in what the visitor is told:
 * "sign in to continue" is the action either way, and an expired-vs-forged breakdown is only useful to someone
 * probing the endpoint. */
export const resolveVisitor = async (
    services: Pick<Services, "workspace" | "members" | "logger">,
    config: WebchatConfig,
    message: Pick<WebchatMessage, "idToken" | "displayName">,
): Promise<VisitorIdentity> => {
    const typed = message.displayName?.trim();
    const displayName = typed === undefined || typed === "" ? undefined : typed;
    const gated = config.access === "google" && config.googleClientId !== undefined;

    if (message.idToken === undefined || config.googleClientId === undefined) {
        if (gated) {
            throw new SignInRequired("sign-in required");
        }
        return { author: displayName ?? "visitor", ...(displayName !== undefined ? { displayName } : {}) };
    }

    let identity: Awaited<ReturnType<IdTokenVerifier>>;
    try {
        identity = await verifierFor(config.googleClientId)(message.idToken);
    } catch (error) {
        services.logger.warn({ err: error }, "web-chat google id token rejected");
        if (gated) {
            throw new SignInRequired("sign-in required");
        }
        // An open Doorbell that was handed an unusable token still serves the visitor — as an anonymous one.
        return { author: displayName ?? "visitor", ...(displayName !== undefined ? { displayName } : {}) };
    }

    const member = (await authorizedEmails(services)).has(identity.email.toLowerCase());
    return {
        author: identity.name ?? identity.email,
        verified: { email: identity.email, ...(identity.name !== undefined ? { name: identity.name } : {}) },
        ...(displayName !== undefined ? { displayName } : {}),
        ...(member ? { member: true } : {}),
    };
};
