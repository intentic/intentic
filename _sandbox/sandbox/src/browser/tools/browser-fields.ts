import type { TurnTools } from "../../agent/providers/agent-request.js";
import { browserOutputDir } from "../cast/browser-artifacts.js";
import type { BrowserTurnTools } from "./browser-tools.js";

// The request fields a browser stack's facts ride on: the output dir only beside a mounted server, and each map only
// when it holds something, since an output dir or a port map without the servers they belong to would have the prompt
// promise tools the turn never mounted. The servers themselves ride `remote` with every other mount (turn-tools.ts).
// Its own module, not browser-tools.ts, so an arm can compose a request without pulling the Chromium bring-up in.
type BrowserFields = Pick<TurnTools, "browserOutputDir" | "browserPorts" | "browserPasskeys" | "browserAccounts" | "desktop">;

export const browserFields = (root: string, browser: BrowserTurnTools): BrowserFields => {
    const fields: { -readonly [Field in keyof BrowserFields]: BrowserFields[Field] } = {};
    if (browser.servers.length > 0) {
        fields.browserOutputDir = browserOutputDir(root);
        if (Object.keys(browser.ports).length > 0) {
            fields.browserPorts = browser.ports;
        }
        if (Object.keys(browser.passkeys).length > 0) {
            fields.browserPasskeys = browser.passkeys;
        }
        if (Object.keys(browser.accounts).length > 0) {
            fields.browserAccounts = browser.accounts;
        }
    }
    if (browser.desktop !== undefined) {
        fields.desktop = true;
    }
    return fields;
};
