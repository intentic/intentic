import { buildApplication, buildRouteMap } from "@stricli/core";
import { commands } from "./commands.js";

// The intentic-sync CLI: `setup` (one-time OAuth + SSH-key enrol + start Mutagen), then `status`/`pause`/
// `resume`/`uninstall`. Mutagen's own daemon does the background syncing + login autostart. Command names map
// to kebab-case flags per stricli's scanner.
export const app = buildApplication(
    buildRouteMap({
        routes: commands,
        docs: { brief: "intentic-sync — mirror a remote sandbox to a local directory" },
    }),
    { name: "intentic-sync", scanner: { caseStyle: "allow-kebab-for-camel" } },
);
