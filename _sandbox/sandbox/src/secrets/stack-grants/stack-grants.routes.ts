import { errorMessage } from "@intentic/base/errors";
import { stackGrantsContract } from "@intentic/sandbox-contract/contracts/stack-grants.contract";
import type { StackGrantRef } from "@intentic/sandbox-contract/schemas/stack-grants";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { noteAudit } from "../../audit/audit-http.js";
import { ensureRight } from "../../auth/owner-gates.js";
import { provenTurnOrRefuse } from "../../auth/scope/proven-turn.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { refuseUnpaired } from "./stack-grants.js";

// WHICH SECRETS EACH MANAGED STACK MAY RECEIVE, OVER THE WIRE (contracts/stack-grants.contract.ts, the store is
// stack-grants.ts). Reading reaches the agent and an extension that declares it (the Deployments board shows what is
// missing). Granting and revoking are the owner's: the contract keeps them off every machine credential, and each handler
// holds its caller to the Secrets right again, as `setGate` does, so no token a route's grants admit can lift its own
// limit. An agent asks on a card instead (`request`, a `deploy` need: needs/kinds/deploy-need.ts).

export type StackGrantsRoutesDeps = Pick<Services, "stackGrants" | "needs" | "capabilities" | "auth">;

const target = (ref: StackGrantRef): string => `${ref.repo}:${ref.stack}@${ref.device}`;

export const createStackGrantsRoutes = (services: StackGrantsRoutesDeps) => {
    const i = implement(stackGrantsContract).$context<OrpcContext>();
    // Names only. Unreadable is an error here, not an empty list: "nothing granted" is a claim this cannot make.
    const all = async () => {
        try {
            return { grants: [...(await services.stackGrants.list())] };
        } catch (error) {
            throw new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error) });
        }
    };
    return {
        list: i.list.handler(all),
        // A card in the asking conversation, answered by the owner.
        request: i.request.handler(({ input, context, signal }) =>
            services.needs.ask({
                raise: { ask: { kind: "deploy", repo: input.repo, stack: input.stack, device: input.device, secrets: input.secrets }, ...opt("why", input.why) },
                conversationId: provenTurnOrRefuse(context.headers),
                signal: signal ?? new AbortController().signal,
            }),
        ),
        grant: i.grant.handler(async ({ input, context }) => {
            await ensureRight(services, context.headers, "secrets");
            noteAudit({ target: target(input) });
            await refuseUnpaired(services, input.device);
            await services.stackGrants.add(input, input.secrets, context.identity?.email);
            return await all();
        }),
        revoke: i.revoke.handler(async ({ input, context }) => {
            await ensureRight(services, context.headers, "secrets");
            noteAudit({ target: target(input) });
            if (!(await services.stackGrants.revoke(input))) {
                throw new ORPCError("NOT_FOUND", { message: `"${input.stack}" from "${input.repo}" holds no grant on "${input.device}" to take back.` });
            }
            return { ok: true } as const;
        }),
    };
};
