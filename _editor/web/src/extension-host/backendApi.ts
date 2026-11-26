import type { IntenticApi } from "@intentic/extension-api";
import { sandboxJson, sandboxRequest } from "../client/sandbox/sandboxClient";

// The host resolves paths into this extension's own namespace. The installed manifest says whether it has a server.
export const extensionBackendApi = (
    backendPath: (path: string) => string,
    declaredServer: string | undefined,
    fromInventory: boolean,
): IntenticApi["backend"] => ({
    ...(fromInventory ? { available: declaredServer !== undefined } : {}),
    request: (path, init) => sandboxRequest(backendPath(path), init),
    json: (path, init) => sandboxJson(backendPath(path), init),
});
