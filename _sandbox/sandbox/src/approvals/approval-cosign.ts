import { cosignChallenge, type PasskeyCosign, type PasskeyCosignChallenge } from "@intentic/sandbox-contract/protocol/s2s/passkey-cosign";
import type { ApprovalPasskeyOptions, ApprovalSummary } from "@intentic/sandbox-contract/schemas/approvals";
import type { AuthenticationResponse } from "@intentic/sandbox-contract/schemas/system";
import { ORPCError } from "@orpc/server";
import { PasskeyError } from "../auth/passkeys/passkey-store.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";

// (2026-11-28) A PERSON'S YES, CO-SIGNED WITH THEIR PASSKEY (docs/architecture/messages.md, "Identity"). An action whose
// filer marked it `cosign: "offered" | "required"` may be approved with a passkey: the challenge is the approval itself,
// SHA-256 over this sandbox's id (as its identity document names it), the item's id and its performer's digest
// (protocol/s2s/passkey-cosign.ts), so the assertion says a person approved exactly what the performer will do. The
// daemon checks it against the approver's own stored passkey (origin, counter, user verification), keeps the resulting
// co-signature with the recorded yes, and hands it to the performer, which may publish it; anyone verifies it with
// `verifyPasskeyCosign`. Only an item naming a performer takes one: the performer's digest is what is co-signed.

type CosignDeps = Pick<Services, "passkeyCeremonies" | "s2sIdentity">;

// What a co-signature over this item binds, or the refusal for an item that cannot take one.
const challengeOf = async (services: CosignDeps, item: ApprovalSummary): Promise<PasskeyCosignChallenge> => {
    if (item.kind !== "action" || item.performer === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "only an action an extension carries out (one naming a performer) can be approved with a passkey" });
    }
    return { v: 1, sandbox: (await services.s2sIdentity.document()).sandbox, item: item.id, digest: item.performer.digest };
};

// A ceremony's refusal as the oRPC error its status means.
const orpcOf = (error: PasskeyError): ORPCError<string, unknown> => {
    const code = error.status === 403 ? "FORBIDDEN" : error.status === 404 ? "NOT_FOUND" : error.status === 429 ? "TOO_MANY_REQUESTS" : "BAD_REQUEST";
    return new ORPCError(code, { message: error.message });
};

// Who is signed in, for a ceremony bound to their own passkeys; none on a sandbox without sign-in, which keeps none.
const signedIn = (email: string | undefined): string => {
    if (email === undefined) {
        throw new ORPCError("FORBIDDEN", { message: "approving with a passkey needs you signed in, with a passkey of your own on this sandbox" });
    }
    return email;
};

// The passkey request for co-signing one item, allowing only the signed-in person's own passkeys.
export const approvalPasskeyOptions = async (
    services: CosignDeps,
    item: ApprovalSummary,
    caller: { readonly email: string | undefined; readonly origin: string | undefined },
): Promise<ApprovalPasskeyOptions> => {
    const challenge = cosignChallenge(await challengeOf(services, item));
    const email = signedIn(caller.email);
    try {
        const options = await services.passkeyCeremonies.cosignOptions({ email, origin: caller.origin, challenge });
        return { ...options, allowCredentials: options.allowCredentials.map((each) => ({ type: each.type, id: each.id, ...opt("transports", each.transports && [...each.transports]) })) };
    } catch (error) {
        throw error instanceof PasskeyError ? orpcOf(error) : error;
    }
};

// The co-signature a yes to `item` is given with: none for an item approved without a passkey (refused when its filer
// required one), else the signed-in person's passkey assertion over the item's challenge, checked against their own
// stored passkey, with that passkey's public key (never their email).
export const approvalCosign = async (
    services: CosignDeps,
    item: ApprovalSummary,
    passkey: AuthenticationResponse | undefined,
    caller: { readonly email: string | undefined; readonly origin: string | undefined },
): Promise<PasskeyCosign | undefined> => {
    if (passkey === undefined) {
        if (item.kind === "action" && item.cosign === "required") {
            throw new ORPCError("PRECONDITION_FAILED", { message: "this item asks for your passkey: approve it with your passkey" });
        }
        return undefined;
    }
    const challenge = await challengeOf(services, item);
    const email = signedIn(caller.email);
    let signed: Awaited<ReturnType<CosignDeps["passkeyCeremonies"]["cosign"]>>;
    try {
        signed = await services.passkeyCeremonies.cosign({ email, origin: caller.origin, challenge: cosignChallenge(challenge), response: passkey });
    } catch (error) {
        throw error instanceof PasskeyError ? orpcOf(error) : error;
    }
    return {
        v: 1,
        challenge,
        credentialId: signed.credential.id,
        publicKey: signed.credential.publicKey,
        rpId: signed.rpId,
        authenticatorData: passkey.response.authenticatorData,
        clientDataJSON: passkey.response.clientDataJSON,
        signature: passkey.response.signature,
        label: signed.credential.label,
    };
};
