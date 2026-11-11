import { secretsContract } from "@intentic/sandbox-contract/contracts/secrets.contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { noteAudit } from "../../audit/audit-http.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";

// An agent asking the owner's computers for a credential by where it is used (`secrets want`, on the agent token), and
// the wants still waiting, which the Secrets view lists for the owner and maintainers like every other secrets read.
// Passwords itself is the owner's computers' (2026-11-11): nothing here lists a vault, only this sandbox's own asks.
// Never a value.

export type WantRoutesDeps = Pick<Services, "keyringNeeds">;

export const createWantRoutes = (services: WantRoutesDeps) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    return {
        want: i.want.handler(async ({ input, context, signal }) => {
            noteAudit({ target: input.origin.kind });
            return services.keyringNeeds.request({
                origin: input.origin,
                ...opt("username", input.username),
                detail: input.why,
                // Body field first, else the header every agent CLI sends.
                ...opt("conversationId", input.conversationId ?? context.headers.get("x-intentic-conversation") ?? undefined),
                ...opt("signal", signal),
            });
        }),
        wants: i.wants.handler(async () => ({ needs: [...(await services.keyringNeeds.pending())] })),
    };
};
