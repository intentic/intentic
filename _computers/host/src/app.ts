import { agentException } from "@intentic/local-agent";
import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { commands } from "./commands.js";

// The intentic-host CLI: `setup` (redeem the sandbox's pairing, connect, and keep connecting at login), `run`
// (the connection loop itself), `status`, `uninstall`. Command names map to kebab-case flags per stricli's
// scanner, matching the sync agent.
export const app = buildApplication(
    buildRouteMap({
        routes: commands,
        docs: { brief: "intentic-host — let your intentic sandbox work on this computer" },
    }),
    {
        name: "intentic-host",
        scanner: { caseStyle: "allow-kebab-for-camel" },
        // Same as the sync agent beside it: a failure reads as the sentence the command threw (agentException).
        localization: { text: { ...text_en, formatException: agentException } },
    },
);
