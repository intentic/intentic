import { buildApplication, buildRouteMap } from "@stricli/core";
import { commands } from "./commands.js";

// The intentic-host CLI: `setup` (redeem the sandbox's pairing, connect, and keep connecting at login), `run`
// (the connection loop itself), `status`, `uninstall`. Command names map to kebab-case flags per stricli's
// scanner, matching the sync agent.
export const app = buildApplication(
    buildRouteMap({
        routes: commands,
        docs: { brief: "intentic-host — let your intentic sandbox work on this computer" },
    }),
    { name: "intentic-host", scanner: { caseStyle: "allow-kebab-for-camel" } },
);
