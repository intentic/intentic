import type { WebchatConfig, WebchatMessage } from "@intentic/sandbox-contract/schemas/automations";
import { z } from "zod";
import { WEBCHAT_PROVIDER } from "./chats.js";

// WHO THE AGENT IS TOLD IT IS TALKING TO. The line it keeps is between a name somebody typed and a name Google signed:
// both reach the agent, in separate fields, so a visitor calling themselves "admin (owner)" never reads like the owner.
//
// The signed half is the daemon's (2026-11-26): `POST /listeners/webchat/identity` verifies a Google ID token against
// the site's own client id and says whether that address is the owner's or a member's. The roster is the sandbox's word
// about its people, so this extension asks one question of it and never reads it; the daemon answers it only for a
// listener strangers reach, to the extension that owns it.

export interface VisitorIdentity {
    // What the board and the activity feed call this visitor; derived, never taken from the browser.
    readonly author: string;
    // Present only when a Google ID token verified against the site's own client id.
    readonly verified?: { readonly email: string; readonly name?: string };
    // The typed name, carried separately and always labelled unverified where the agent reads it.
    displayName?: string;
    // The verified address is the owner's or a member's: a claim on the message, not a grant to anything.
    member?: true;
}

export class SignInRequired extends Error {}

// What the daemon's door answers for a token that verified.
const VerifiedSchema = z.object({ email: z.string(), name: z.string().optional(), member: z.boolean() });
export type VerifiedVisitor = z.infer<typeof VerifiedSchema>;

/** Verifies an ID token for a site's client id: who it names, or undefined when it does not verify. */
export type VerifyIdToken = (clientId: string, idToken: string) => Promise<VerifiedVisitor | undefined>;

/** The daemon's identity door, through this extension's own listener (`api.daemon.request`). */
export const daemonVerifier =
    (request: (path: string, init?: RequestInit) => Promise<Response>, log: (message: string) => void): VerifyIdToken =>
    async (clientId, idToken) => {
        const response = await request(`/listeners/${WEBCHAT_PROVIDER}/identity`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ kind: `google`, clientId, idToken }),
        });
        if (response.status === 401) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`the sandbox could not check a visitor's sign-in (${response.status}): ${(await response.text()).slice(0, 200)}`);
        }
        const verified = VerifiedSchema.safeParse(await response.json());
        if (!verified.success) {
            log(`the sandbox's identity door answered a shape this build cannot read`);
            return undefined;
        }
        return verified.data;
    };

const anonymous = (displayName: string | undefined): VisitorIdentity =>
    displayName === undefined ? { author: `visitor` } : { author: displayName, displayName };

/**
 * One message's sender. Throws SignInRequired when the chat asks for sign-in and the token is missing or does not verify:
 * either way the visitor's next step is the same, so they read the same.
 */
export const resolveVisitor = async (verify: VerifyIdToken, config: WebchatConfig, message: Pick<WebchatMessage, `idToken` | `displayName`>): Promise<VisitorIdentity> => {
    const typed = message.displayName?.trim();
    const displayName = typed === undefined || typed === `` ? undefined : typed;
    const gated = config.access === `google` && config.googleClientId !== undefined;
    if (message.idToken === undefined || config.googleClientId === undefined) {
        if (gated) {
            throw new SignInRequired(`sign-in required`);
        }
        return anonymous(displayName);
    }
    const identity = await verify(config.googleClientId, message.idToken);
    if (identity === undefined) {
        if (gated) {
            throw new SignInRequired(`sign-in required`);
        }
        // An open chat handed an unusable token still serves the visitor, as an anonymous one.
        return anonymous(displayName);
    }
    const verified = identity.name === undefined ? { email: identity.email } : { email: identity.email, name: identity.name };
    const who: VisitorIdentity = { author: identity.name ?? identity.email, verified };
    if (displayName !== undefined) {
        who.displayName = displayName;
    }
    if (identity.member) {
        who.member = true;
    }
    return who;
};
