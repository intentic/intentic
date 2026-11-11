import { capabilitiesContract } from "@intentic/sandbox-contract/contracts/capabilities.contract";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import type { Services } from "../../composition.js";
import { contributionRegistry } from "../contributions.js";
import type { ExtensionHost } from "../extension-inventory/installed-extensions.js";
import { createMcpSignInRoutes } from "../mcp-oauth/mcp-sign-in.handlers.js";
import { createDeviceSignIns } from "../sign-in/device-sign-in.js";
import { certificateRequestFor } from "./key-requests.js";
import type { SecretStash } from "./secret-stash.js";

// The capability routes that get a form a credential it cannot type: a key and its certificate request
// (key-requests.ts), a device-code sign-in (device-sign-in.ts), an MCP server's OAuth sign-in (mcp-sign-in.handlers.ts).
// Merged into the `capabilities` group by capabilities.routes.ts, which hands in its stash: each credential waits there
// under a token for the add that saves the connection, as a generated SSH key does. `keep` is that group's own
// resolution of the markers an edit form sends for what it keeps (withKeptSecrets).
export const createFormCredentialRoutes = (
    services: ExtensionHost & Pick<Services, "mcpSignIns">,
    stash: SecretStash,
    keep: (input: Capability) => Promise<Capability>,
) => {
    const i = implement(capabilitiesContract).$context<OrpcContext>();
    // Sign-ins forms started (device-sign-in.ts), whose tokens wait in that stash for the add, as a generated key does.
    const signIns = createDeviceSignIns(stash);
    return {
        certificateRequest: i.certificateRequest.handler(async ({ input }) => certificateRequestFor(await contributionRegistry(services), stash, input)),
        deviceSignIn: i.deviceSignIn.handler(async ({ input }) => signIns.start(await contributionRegistry(services), await keep(input))),
        deviceSignInWait: i.deviceSignInWait.handler(({ input }) => signIns.wait(input.flow)),
        // An MCP server's OAuth sign-in: its finished session waits in this stash for the add, as a generated key does.
        ...createMcpSignInRoutes(services.mcpSignIns, stash),
    };
};
