import { agentException } from "@intentic/local-agent";
import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { commands } from "./commands.js";
import { MACHINE_VERSION } from "./version.js";

// The intentic-machine CLI: `device setup` (redeem a device card's pairing and stay connected at login),
// `sync setup` (redeem a Desktop sync card's pairing and keep a folder + ports mirrored), then the shared
// residency: `run` (the one background agent for both), `status`, `upgrade`, `uninstall`. Command names map to
// kebab-case flags per stricli's scanner.
export const app = buildApplication(
    buildRouteMap({
        routes: commands,
        docs: { brief: "intentic-machine, connect this device to your intentic sandboxes" },
    }),
    {
        name: "intentic-machine",
        // `--version`/`-v` is what a person types; the `version` command stays because the release build and `upgrade`
        // parse its bare string, which a flag's framing would break.
        versionInfo: { currentVersion: MACHINE_VERSION },
        scanner: { caseStyle: "allow-kebab-for-camel" },
        // A failure reads as the sentence the command threw, not as frames inside a compiled binary (agentException),
        // and without stricli's "Command failed, " in front of a sentence that already names the problem and its fix.
        localization: {
            text: {
                ...text_en,
                formatException: agentException,
                exceptionWhileRunningCommand: (exc: unknown) => `FAILED: ${agentException(exc)}`,
            },
        },
    },
);
