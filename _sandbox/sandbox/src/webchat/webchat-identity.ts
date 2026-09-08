import type { WebchatConfig, WebchatMessage } from "@intentic/sandbox-contract";
import { createGoogleVerifier, fileOwnerStore, type IdTokenVerifier } from "../auth/auth.js";
import type { Services } from "../composition.js";
import { statePath } from "../workspace/layout/state-paths.js";

// Who the daemon tells the model it is talking to.
// The distinction it keeps is between a name someone typed and a name Google signed: both reach the prompt, but a
// visitor calling themselves "admin (owner)" must not read like the owner, so the two travel in separate fields.

export interface VisitorIdentity {
    // What the fleet board and activity feed call this visitor; derived, never taken from the client.
    readonly author: string;
    // Present only when a Google ID token verified against the site's own client id.
    readonly verified?: { email: string; name?: string };
    // The typed name, carried separately and always labelled unverified where the model can see it.
    readonly displayName?: string;
    // The verified email is the owner or a member; a claim on the message, not a grant to anything.
    readonly member?: boolean;
}

export class SignInRequired extends Error {}

// One verifier per client id, cached for the daemon's life so its JWKS isn't refetched every message.
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

// Emails that can already reach this sandbox: owner plus every member. Read per message, not cached, since a stale
// `member` tag would misidentify who is talking.
const authorizedEmails = async (services: Pick<Services, "workspace" | "members">): Promise<Set<string>> => {
    const owner = await fileOwnerStore(statePath(services.workspace.root, ".intentic/identity/owner.json")).read();
    const members = await services.members.list();
    return new Set([...(owner === undefined ? [] : [owner]), ...members.map(({ email }) => email)].map((email) => email.toLowerCase()));
};

// Resolves one message's sender; throws SignInRequired when sign-in is required and the token is missing or bad. A
// failed verification reads the same as a missing token to the visitor: the action is the same either way.
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
        // An open Front Desk that was handed an unusable token still serves the visitor, as an anonymous one.
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
