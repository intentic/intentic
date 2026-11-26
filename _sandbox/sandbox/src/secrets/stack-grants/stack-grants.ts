import { type StackGrant, type StackGrantRef, StackGrantSchema } from "@intentic/sandbox-contract/schemas/stack-grants";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// WHICH SECRETS EACH MANAGED STACK MAY RECEIVE (schemas/stack-grants.ts): the owner's yes, kept in the auth root beside
// the credential gates (mode 0600, off the file routes and the tree walk), since `.intentic/` is the agent's to write and
// a grant there would be a turn granting itself, and an extension has no door to this root at all. A grant names a
// repository, a stack AND the computer by its device card's id, so moving a stack to another computer asks again; it
// covers exactly the names it lists, so a stack that starts reading one more secret is refused until the owner grants
// that one too. Never travels in a bundle (the auth table's `identity`): a sandbox restored elsewhere asks its owner
// again. Read by the managed deploy (hosts/stacks/managed-deploy.ts), written by the owner's routes
// (stack-grants.routes.ts) and the `deploy` need's press (needs/kinds/deploy-need.ts). (2026-11-25) Was the daemon's own
// deploy engine's `deploy-grants.json`, keyed by the device as a manifest named it; never released under that name.

const StackGrantsFileSchema = z.object({ grants: z.array(StackGrantSchema) });

export const stackGrantsDocument = defineDocument({ root: "auth", path: "stack-grants.json", schema: StackGrantsFileSchema });

export interface StackGrantsStore {
    // Every grant; throws when the file exists and cannot be read, which must never read as "nothing granted" to a
    // writer, nor as "everything" to anybody.
    readonly list: () => Promise<readonly StackGrant[]>;
    readonly forStack: (ref: StackGrantRef) => Promise<StackGrant | undefined>;
    // Adds `secrets` to what the stack holds on that computer (a grant of its own when it holds none); the grant as kept.
    readonly add: (ref: StackGrantRef, secrets: readonly string[], grantedBy: string | undefined) => Promise<StackGrant>;
    // Takes the stack's grant on that computer back; whether there was one.
    readonly revoke: (ref: StackGrantRef) => Promise<boolean>;
}

const sameRef = (grant: StackGrantRef, ref: StackGrantRef): boolean => grant.repo === ref.repo && grant.stack === ref.stack && grant.device === ref.device;

// The grant with `secrets` added, sorted and once each; stamped with who added them and when.
const widened = (held: StackGrant | undefined, ref: StackGrantRef, secrets: readonly string[], grantedBy: string | undefined, at: string): StackGrant => ({
    repo: ref.repo,
    stack: ref.stack,
    device: ref.device,
    secrets: [...new Set([...(held?.secrets ?? []), ...secrets])].toSorted(),
    ...opt("grantedBy", grantedBy),
    grantedAt: at,
});

// The device card a grant names, or the refusal: a grant is for a computer this sandbox is paired with, by its card's id
// (the name Devices shows it under).
export const refuseUnpaired = async (services: Pick<Services, "capabilities">, device: string): Promise<void> => {
    const paired = (await services.capabilities.list()).some((capability) => capability.kind === "device" && capability.id === device);
    if (!paired) {
        throw new ORPCError("BAD_REQUEST", { message: `"${device}" is not a computer paired with this sandbox: name one by its device card's id, as Devices lists it.` });
    }
};

// The same, answering what the computer calls itself when its agent has said, for a card to show beside the id.
export const pairedDevice = async (services: Pick<Services, "capabilities" | "hostHub">, device: string): Promise<{ readonly hostname: string | undefined }> => {
    await refuseUnpaired(services, device);
    const hostname = services.hostHub.state(device).facts?.hostname;
    return { hostname: hostname === device ? undefined : hostname };
};

export const fileStackGrants = (path: string, now: () => Date = () => new Date()): StackGrantsStore => {
    const file = openDocument(stackGrantsDocument, path, {
        fallback: () => ({ grants: [] }),
        mode: 0o600,
        // A fresh file over an unreadable one would drop every grant the owner gave; refused, for the owner to fix.
        onUnreadable: "refuse",
    });
    const list = async (): Promise<readonly StackGrant[]> => {
        const state = await file.state();
        if (state.unreadable) {
            throw new Error(`the stack grants at ${path} could not be read (${state.detail})`);
        }
        return state.value.grants;
    };
    return {
        list,
        forStack: async (ref) => (await list()).find((grant) => sameRef(grant, ref)),
        add: async (ref, secrets, grantedBy) => {
            let kept: StackGrant | undefined;
            await file.update((current) => {
                kept = widened(
                    current.grants.find((grant) => sameRef(grant, ref)),
                    ref,
                    secrets,
                    grantedBy,
                    now().toISOString(),
                );
                return { ...current, grants: [...current.grants.filter((grant) => !sameRef(grant, ref)), kept] };
            });
            if (kept === undefined) {
                throw new Error(`the stack grant for "${ref.stack}" was not written`);
            }
            return kept;
        },
        revoke: async (ref) => {
            let removed = false;
            await file.update((current) => {
                const kept = current.grants.filter((grant) => !sameRef(grant, ref));
                removed = kept.length < current.grants.length;
                return removed ? { ...current, grants: kept } : current;
            });
            return removed;
        },
    };
};

// The same over memory, for the route suites (secrets-slice.testing.ts).
export const memoryStackGrants = (held: readonly StackGrant[] = [], now: () => Date = () => new Date()): StackGrantsStore => {
    let grants = [...held];
    return {
        list: async () => grants,
        forStack: async (ref) => grants.find((grant) => sameRef(grant, ref)),
        add: async (ref, secrets, grantedBy) => {
            const kept = widened(
                grants.find((grant) => sameRef(grant, ref)),
                ref,
                secrets,
                grantedBy,
                now().toISOString(),
            );
            grants = [...grants.filter((grant) => !sameRef(grant, ref)), kept];
            return kept;
        },
        revoke: async (ref) => {
            const before = grants.length;
            grants = grants.filter((grant) => !sameRef(grant, ref));
            return grants.length < before;
        },
    };
};
