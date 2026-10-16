import { defineRawRoutes } from "../http/raw-route-server.js";
import type { Services } from "../composition.js";
import { createDesktopViewRoute } from "./desktop-view.js";

// The sandbox's own desktop, watched and driven by the owner.
export const desktopViewRawRoutes = defineRawRoutes((services: Services) => ({ "GET /system/desktop-view": createDesktopViewRoute(services) }));
