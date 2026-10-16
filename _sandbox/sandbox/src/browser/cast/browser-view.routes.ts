import { defineRawRoutes } from "../../http/raw-route-server.js";
import type { Services } from "../../composition.js";
import { createBrowserViewRoute } from "./browser-view.js";

// Watch the browser the agent drives: the same screencast wire, attached to a live browser-* session.
export const browserViewRawRoutes = defineRawRoutes((services: Services) => ({ "GET /system/browser-view": createBrowserViewRoute(services) }));
