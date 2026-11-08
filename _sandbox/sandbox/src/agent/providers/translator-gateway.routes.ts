import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";

export const translatorGatewayRawRoutes = defineRawRoutes((services: Pick<Services, "translatorGateway">) => ({
    // The translator's front door for every routed loop's model requests (translator-gateway.ts), on a session signed for
    // one provider: each request naming a model is placed on one of its accounts, and a refusal is filed under the
    // account that gave it. Read per request rather than at build, so a suite that never sends one need not stand it up.
    "ALL /translator-gateway/{session}/*": (c) => services.translatorGateway.route(c),
}));
