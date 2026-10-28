import { madeOnThisPage, rowAt } from "../../world/sandboxRegistry";
import { type HomeSandbox, recordedSandboxAt } from "./sandboxes";

// WHICH SANDBOX A CALL IS FOR, by the daemon address it was sent to. Apart from sandboxes.ts because the registry it reads
// imports the account, which imports sandboxes.ts: the cycle would leave HOME_SANDBOXES unset while the account is built.

/**
 * One of the recording's three; a sandbox the visitor made on this page, as its own (so its home conversation is not the
 * shop's); anything else is the shop, the sandbox every other mode serves.
 */
export const homeSandboxOf = (url: URL): HomeSandbox => {
    const recorded = recordedSandboxAt(url);
    if (recorded !== undefined) {
        return recorded;
    }
    const row = rowAt(url.origin);
    return row !== undefined && madeOnThisPage(row.id) ? `made:${url.origin}` : `shop`;
};
