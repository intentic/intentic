import type { Context } from "hono";
import { liveCardRun } from "../../agent/run/offer-card.js";
import type { Services } from "../../composition.js";
import type { AppEnv } from "../../app-env.js";
import { relayServiceCatalog, relayServiceRun, relayServiceWant } from "./pool-services.js";
import { gatedServiceRun } from "./service-offer.js";

/* The creator pool's metered services, relayed to the platform (platform/pool-services.ts), the catalog
 * with the owner's credit meter, and one priced run. The daemon contributes the connect token; the
 * platform holds the member gate, the meter and the refund discipline, and its refusals are already
 * written for the reader. These are the routes an extension backend declares in `permissions.daemon` to
 * spend the owner's credits, a mutation, so the bearer middleware floors the run at maintainer for
 * browsers, like every unlisted POST.
 *
 * WHO GETS GATED: the AGENT's own run call, the request that presented the agent token, which commits it
 * to that grant (grants.ts), parks on an owner-approval card before anything is spent
 * (platform/service-offer.ts). An extension backend passes straight through: which services it may run is
 * declared in its manifest and was approved at install. A browser session is the owner acting directly. */

export type PoolRoutesDeps = Pick<Services, "config" | "agents">;

export const createPoolRoutes = (services: PoolRoutesDeps) => ({
    /** GET /pool/services */
    catalog: async (c: Context<AppEnv>): Promise<Response> => {
        const answer = await relayServiceCatalog(services.config);
        return c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType });
    },
    // POST /pool/wanted. The wanted list: an agent that read the catalog and found nothing that answers files
    // what it looked for. No spend, no card, the platform bounds it (length, a daily cap per owner) and
    // publishes only the aggregate, so this relays as plainly as the catalog read above.
    wanted: async (c: Context<AppEnv>): Promise<Response> => {
        const answer = await relayServiceWant(services.config, await c.req.text());
        return c.newResponse(answer.body, answer.status as 200, { "content-type": answer.contentType });
    },
    /** POST /pool/services/:slug/run */
    run: async (c: Context<AppEnv, "/pool/services/:slug/run">): Promise<Response> => {
        const viaAgent = (c.req.header("x-intentic-agent") ?? "") !== "";
        const answer = viaAgent
            ? await gatedServiceRun(
                  {
                      catalog: () => relayServiceCatalog(services.config),
                      run: (slug, body, onStatus) => relayServiceRun(services.config, slug, body, onStatus),
                      liveRun: liveCardRun,
                      observe: services.agents.observe,
                  },
                  {
                      slug: c.req.param("slug"),
                      body: await c.req.text(),
                      conversationId: c.req.header("x-intentic-conversation"),
                      why: c.req.query("why"),
                      signal: c.req.raw.signal,
                  },
              )
            : await relayServiceRun(services.config, c.req.param("slug"), await c.req.text());
        return c.newResponse(answer.body, answer.status as 200, {
            "content-type": answer.contentType,
            // The platform's advisory meter header rides through, so every caller's receipt line works.
            ...(answer.remaining !== undefined ? { "x-intentic-credits-remaining": answer.remaining } : {}),
        });
    },
});
