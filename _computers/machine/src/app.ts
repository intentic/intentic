import { agentException } from "@intentic/local-agent";
import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { commands } from "./commands.js";

// The intentic-machine CLI: `computer setup` (redeem a computer card's pairing and stay connected at login),
// `sync setup` (redeem a Desktop sync card's pairing and keep a folder + ports mirrored), then the shared
// residency: `run` (the one background loop for both), `status`, `upgrade`, `uninstall`. Command names map to
// kebab-case flags per stricli's scanner.
export const app = buildApplication(
    buildRouteMap({
        routes: commands,
        docs: { brief: "intentic-machine, connect this computer to your intentic sandboxes" },
    }),
    {
        name: "intentic-machine",
        scanner: { caseStyle: "allow-kebab-for-camel" },
        // A failure reads as the sentence the command threw, not as frames inside a compiled binary (agentException).
        localization: { text: { ...text_en, formatException: agentException } },
    },
);
