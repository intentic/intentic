import type { MintedIdentityAssertion } from "@intentic/api-contract";
import { IDENTITY_ASSERTION_TTL_MS, mintIdentityAssertion } from "@intentic/sandbox-contract/identity-assertion";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { decryptSecret } from "../crypto.js";
import { requireUser } from "../guards.js";
import { emailSignInEnabled, hasGoogleAccount } from "../sign-in.js";

// The platform's signed word that the caller controls their address, for one sandbox they own or accepted an invitation
// to (sandbox-contract policy/identity-assertion.ts). It is how an account that signs in by email reaches its sandboxes,
// whose daemons verify Google themselves and so could never see this sign-in otherwise. The daemon decides what it opens:
// off a hosted machine, only the owner who bound with one and the members the owner opted in to email sign-in, so the
// platform's word alone never opens a sandbox for a person who signs in there with Google.
export const mintIdentityAssertionFor = async (context: OrpcContext, sandboxId: string): Promise<MintedIdentityAssertion> => {
    const user = requireUser(context);
    if (context.config.identity.signingKey === `` || !emailSignInEnabled(context.config)) {
        throw new ORPCError(`NOT_FOUND`, { message: `this platform vouches for no sign-in to sandboxes` });
    }
    if (!user.emailVerified) {
        throw new ORPCError(`FORBIDDEN`, { message: `this account's address has not been confirmed: sign in with a code mailed to it first` });
    }
    const email = user.email.toLowerCase();
    // The owner, or a member whose invitation was accepted; the daemon checks its own roster on top.
    const sandbox = await context.prisma.sandbox.findFirst({
        where: { id: sandboxId, OR: [{ ownerId: user.id }, { members: { some: { email, acceptedAt: { not: null } } } }] },
        select: { token: true },
    });
    if (sandbox === null) {
        throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
    }
    const tunnelId = sandboxIdFromToken(decryptSecret(context.config, sandbox.token));
    if (tunnelId === undefined) {
        throw new ORPCError(`NOT_FOUND`, { message: `sandbox not found` });
    }
    const issuedAtMs = Date.now();
    const method = (await hasGoogleAccount(context.prisma, user.id)) ? `google` : `email`;
    return {
        assertion: mintIdentityAssertion(context.config.identity.signingKey, { sandboxId: tunnelId, email, method, issuedAtMs }),
        expiresAt: new Date(issuedAtMs + IDENTITY_ASSERTION_TTL_MS).toISOString(),
    };
};
