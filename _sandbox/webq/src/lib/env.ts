/* The one directory webq owns beyond the shared agent-CLI layout (@intentic/agent-cli/env). */
import { join } from "node:path";
import { toolHome } from "@intentic/agent-cli/env";

// One store for every render mode: a static fetch and a browser fetch of the same URL are one network trip.
export const cacheDir = (): string => join(toolHome("webq"), "cache");
