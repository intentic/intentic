import { agentException } from "@intentic/local-agent";
import { buildApplication, buildRouteMap, text_en } from "@stricli/core";
import { commands } from "./commands.js";

// The intentic-sync CLI: `setup` (one-time OAuth + SSH-key enrol + start Mutagen), `mirror` (workspace ports →
// this machine's localhost, so remote dev feels local), then `status`/`pause`/`resume`/`uninstall`. Mutagen's
// own daemon does the background syncing/forwarding + login autostart. Command names map to kebab-case flags
// per stricli's scanner.
export const app = buildApplication(
    buildRouteMap({
        routes: commands,
        docs: { brief: "intentic-sync — mirror a remote sandbox to a local directory" },
    }),
    {
        name: "intentic-sync",
        scanner: { caseStyle: "allow-kebab-for-camel" },
        // A failure reads as the sentence the command threw, not as frames inside a compiled binary (agentException).
        localization: { text: { ...text_en, formatException: agentException } },
    },
);
