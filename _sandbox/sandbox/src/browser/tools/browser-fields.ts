import type { TurnTools } from "../../agent/providers/agent-request.js";
import { browserOutputDir } from "../cast/browser-artifacts.js";
import type { BrowserTurnTools } from "./browser-tools.js";

// The request fields a browser stack's facts ride on: the output dir only beside a mounted server, and each map only
// when it holds something, since an output dir or a port map without the servers they belong to would have the prompt
// promise tools the turn never mounted. The servers themselves ride `remote` with every other mount (turn-tools.ts).
// Its own module, not browser-tools.ts, so an arm can compose a request without pulling the Chromium bring-up in.
export const browserFields = (
    root: string,
    browser: BrowserTurnTools,
): Pick<TurnTools, "browserOutputDir" | "browserPorts" | "browserPasskeys" | "browserAccounts"> =>
    browser.servers.length === 0
        ? {}
        : {
              browserOutputDir: browserOutputDir(root),
              ...(Object.keys(browser.ports).length > 0 ? { browserPorts: browser.ports } : {}),
              ...(Object.keys(browser.passkeys).length > 0 ? { browserPasskeys: browser.passkeys } : {}),
              ...(Object.keys(browser.accounts).length > 0 ? { browserAccounts: browser.accounts } : {}),
          };
