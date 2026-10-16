import type { Services } from "../../composition.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { createKeyringKeysRoute } from "./keyring-keys.js";

// This sandbox's keyring keys, public halves only: a keyring fetches them here, from the sandbox's own address, before
// it shares anything with it (keyring-keys.ts).
export const keyringKeysRawRoutes = defineRawRoutes((services: Pick<Services, "sandboxKeyringKeys">) => ({
    "GET /keyring/keys": createKeyringKeysRoute(services.sandboxKeyringKeys),
}));
