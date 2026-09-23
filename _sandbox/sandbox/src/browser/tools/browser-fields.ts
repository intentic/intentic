import type { TurnTools } from "../../agent/providers/agent-request.js";
import { browserOutputDir } from "../cast/browser-artifacts.js";
import type { BrowserTurnTools } from "./browser-tools.js";

// The request fields a browser stack rides on, all five or none: an output dir or a port map without the servers they
// belong to would have the prompt promise tools the turn never mounted. Its own module, not browser-tools.ts, so an
// arm can compose a request without pulling the Chromium bring-up in behind it.
export const browserFields = (
    root: string,
    browser: BrowserTurnTools,
): Pick<TurnTools, "sdkServers" | "browserOutputDir" | "browserPorts" | "browserPasskeys" | "browserAccounts"> =>
    Object.keys(browser.servers).length === 0
        ? {}
        : {
              sdkServers: browser.servers,
              browserOutputDir: browserOutputDir(root),
              browserPorts: browser.ports,
              browserPasskeys: browser.passkeys,
              browserAccounts: browser.accounts,
          };
