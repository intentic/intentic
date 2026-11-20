import type { Services } from "../composition.js";
import { createDevtoolsRoutes } from "./devtools/devtools.routes.js";
import { createDownloadsRoutes } from "./downloads/downloads.routes.js";
import { createPermissionsRoutes } from "./permissions/permissions.routes.js";
import { createUploadsRoutes } from "./uploads/uploads.routes.js";
import { createRecordingRoutes } from "./media/recording.routes.js";

// The `browser` routes: what a browser window does besides showing its pages (contracts/browser.contract.ts), its
// downloads, the files and permissions its pages ask for, the tools around a page and its recordings, each served by
// its own module.
export const createBrowserToolsRoutes = (services: Services) => ({
    ...createDownloadsRoutes(services),
    ...createUploadsRoutes(),
    ...createPermissionsRoutes(services),
    ...createDevtoolsRoutes(services),
    ...createRecordingRoutes(services),
});
