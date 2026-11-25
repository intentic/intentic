import { type DeployGrant, DeployGrantSchema } from "@intentic/sandbox-contract/schemas/deploys";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// WHICH SECRETS EACH MANAGED STACK MAY RECEIVE (schemas/deploys.ts DeployGrantSchema): the owner's yes, kept in the auth
// root beside the credential gates (mode 0600, off the file routes and the tree walk), since `.intentic/` is the
// agent's to write and a grant there would be a turn granting itself. A grant names a repository, a stack AND the
// computer as the manifest names it, so moving a stack to another computer asks again; it covers exactly the names it
// lists, so a manifest that starts reading one more secret is refused until the owner grants that one too. Never
// travels in a bundle (the auth table's `identity`): a sandbox restored elsewhere asks its owner again.

const DeployGrantsFileSchema = z.object({ grants: z.array(DeployGrantSchema) });

export const deployGrantsDocument = defineDocument({ root: "auth", path: "deploy-grants.json", schema: DeployGrantsFileSchema });

export interface DeployGrantsStore {
    // Every grant; throws when the file exists and cannot be read, which must never read as "nothing granted" to a
    // writer, nor as "everything" to anybody.
    readonly list: () => Promise<readonly DeployGrant[]>;
    readonly forStack: (repo: string, stack: string, device: string) => Promise<DeployGrant | undefined>;
    // Replaces the grant for the same repository, stack and computer.
    readonly set: (grant: DeployGrant) => Promise<void>;
    // Removes the stack's grants on every computer; how many there were.
    readonly revoke: (repo: string, stack: string) => Promise<number>;
}

const sameStack = (grant: Pick<DeployGrant, "repo" | "stack">, repo: string, stack: string): boolean => grant.repo === repo && grant.stack === stack;

export const fileDeployGrants = (path: string): DeployGrantsStore => {
    const file = openDocument(deployGrantsDocument, path, {
        fallback: () => ({ grants: [] }),
        mode: 0o600,
        // A fresh file over an unreadable one would drop every grant the owner gave; refused, for the owner to fix.
        onUnreadable: "refuse",
    });
    const list = async (): Promise<readonly DeployGrant[]> => {
        const state = await file.state();
        if (state.unreadable) {
            throw new Error(`the deploy grants at ${path} could not be read (${state.detail})`);
        }
        return state.value.grants;
    };
    return {
        list,
        forStack: async (repo, stack, device) => (await list()).find((grant) => sameStack(grant, repo, stack) && grant.device === device),
        set: async (grant) => {
            await file.update((current) => ({
                ...current,
                grants: [...current.grants.filter((held) => !(sameStack(held, grant.repo, grant.stack) && held.device === grant.device)), grant],
            }));
        },
        revoke: async (repo, stack) => {
            let removed = 0;
            await file.update((current) => {
                const kept = current.grants.filter((grant) => !sameStack(grant, repo, stack));
                removed = current.grants.length - kept.length;
                return removed === 0 ? current : { ...current, grants: kept };
            });
            return removed;
        },
    };
};
