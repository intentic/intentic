import { settingsContract } from "@intentic/sandbox-contract/contracts/settings.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { connectedAccountIdentity } from "../capabilities/cli/git-access.js";
import { commitIdentityState, memberCommitIdentities, memberOfCaller } from "../git/attribution/commit-attribution.js";

// A person's own commit identity (git/attribution/commit-attribution.ts), read and set by the person themselves: a
// program's token names nobody to set one for, and nobody sets another member's. Here rather than beside it, since the
// owner's suggestion is the connected git account's and git sits below the connections that hold it.
export const createCommitIdentityRoutes = (services: Pick<Services, "config" | "sandboxSettings" | "auth" | "ownerEmail" | "capabilities">) => {
    const i = implement(settingsContract).$context<OrpcContext>();
    const suggest = async () => connectedAccountIdentity(await services.capabilities.list());
    return {
        commitIdentity: i.commitIdentity.handler(async ({ context }) => {
            const member = memberOfCaller(services, context.identity);
            return member === undefined ? { attribution: (await services.sandboxSettings.get()).commitAttribution } : commitIdentityState(services, member, suggest);
        }),
        setCommitIdentity: i.setCommitIdentity.handler(async ({ input, context }) => {
            const member = memberOfCaller(services, context.identity);
            if (member === undefined) {
                throw new ORPCError("FORBIDDEN", { message: "A commit identity is a person's own: sign in to set yours." });
            }
            await memberCommitIdentities(services).set(member, input.identity ?? undefined);
            return commitIdentityState(services, member, suggest);
        }),
    };
};
