import { type MemberRole, MemberRoleSchema } from "@intentic/sandbox-contract/schemas/shared";
import type { MemberRefusal } from "@intentic/sandbox-contract/protocol/member-reach";
import { readRefusalsWith } from "../../../lib/queryPersistence";
import { type RefusalWords, SandboxHttpError } from "../sandboxHttpError";

// WHY THE SIGNED-IN PERSON MAY NOT DO SOMETHING HERE, in the terms the editor acts on rather than the daemon's sentence:
// a tier the route wants (an owner-only route is the owner tier), running agents off for them, a guest asking for a
// door not on its list, a folder outside their areas, no AI account of theirs to run a turn on (Access ▸ People, which
// the editor foresees from their own access and the daemon refuses at a turn's planning, never as a 403), or an
// organisation managing that part of the sandbox. One answer
// whether the editor foresaw the refusal (access/useAccess.ts) or the daemon made it, so a view draws both alike.
export type AccessReason =
    | { readonly kind: `tier`; readonly floor: MemberRole }
    | { readonly kind: `agents-off` }
    | { readonly kind: `guest` }
    | { readonly kind: `area` }
    | { readonly kind: `ai-accounts` }
    | { readonly kind: `org`; readonly org: string; readonly section: string };

/** The reason the shared access check (sandbox-contract protocol/member-reach.ts) gives, in the editor's terms. */
export const reasonOfRefusal = (refusal: MemberRefusal): AccessReason => {
    if (refusal.reason === `guest`) {
        return { kind: `guest` };
    }
    return refusal.reason === `agents-off` ? { kind: `agents-off` } : { kind: `tier`, floor: refusal.floor };
};

/**
 * Whether a failed call was the person's access rather than a failure: a 403 naming an access reason. Undefined for
 * every other failure, which a view still says as one. A 403 that names nothing (a door's own credential, a wrong
 * account) is not an access answer the editor can act on, and stays a failure.
 */
export const accessReasonOf = (error: Error | null | undefined): AccessReason | undefined =>
    error instanceof SandboxHttpError ? reasonOfAnswer(error.status, error.said) : undefined;

/** The same reading of a refusal the daemon answered, before it is wrapped as an error. */
export const reasonOfAnswer = (status: number, said: RefusalWords): AccessReason | undefined => {
    if (status !== 403) {
        return undefined;
    }
    const { floor, reason, org, section } = said;
    if (reason === `org-locked` && org !== undefined && section !== undefined) {
        return { kind: `org`, org, section };
    }
    if (reason === `guest` || reason === `agents-off` || reason === `area`) {
        return { kind: reason };
    }
    const tier = MemberRoleSchema.safeParse(floor);
    return tier.success ? { kind: `tier`, floor: tier.data } : undefined;
};

/** Whether the editor refused this call itself, before sending it, because the person's access already said no. */
export const foreseenRefusal = (error: Error | null | undefined): boolean => error instanceof SandboxHttpError && error.said.predicted === true;

// The query cache's reading of a failed read (lib/queryPersistence.ts), which sits below this client and cannot import it.
readRefusalsWith((error) => {
    if (foreseenRefusal(error)) {
        return `foreseen`;
    }
    return accessReasonOf(error) === undefined ? undefined : `refused`;
});
