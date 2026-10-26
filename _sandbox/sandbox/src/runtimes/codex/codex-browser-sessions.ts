import { openBrowserSession } from "../../browser/sessions/browser-sessions.js";
import { ROUTED_BROWSER_SERVER } from "../../browser/tools/browser-tools.js";
import type { CodexItem } from "./codex-app-server.js";

export interface CodexBrowserContext {
    readonly ports: Readonly<Record<string, number>>;
    readonly passkeys: Readonly<Record<string, string>>;
    // Routed browser server's account→owner map; a routed call attributes only when every route shares one owner.
    readonly accounts: Readonly<Record<string, string>>;
    readonly owner?: string;
    // Present only on a resumed invocation; a new thread learns its id from thread.started first.
    readonly sessionId?: string;
}

// The one profile a routed call can be pinned to without seeing its arguments; defined only if every account maps to
// the same owner.
const soleRoutedOwner = (browser: CodexBrowserContext | undefined): string | undefined => {
    const owners = new Set(Object.values(browser?.accounts ?? {}));
    return owners.size === 1 ? [...owners][0] : undefined;
};

// Ties a browser call to the profile whose session drives it, so opened pages belong to that account. A routed server's
// calls carry no account in the item, so they attach only when the turn resolves to a single profile.
export const attachBrowserSession = (
    item: Extract<CodexItem, { type: "mcp_tool_call" }>,
    threadId: string | undefined,
    browser: CodexBrowserContext | undefined,
): string | undefined => {
    if (browser === undefined || !item.tool.startsWith("browser_")) {
        return;
    }
    const profile = item.server === ROUTED_BROWSER_SERVER ? soleRoutedOwner(browser) : item.server;
    const port = profile === undefined ? undefined : browser.ports[profile];
    const sessionId = threadId ?? browser.sessionId;
    if (profile === undefined || port === undefined || sessionId === undefined) {
        return;
    }
    return openBrowserSession({ sessionId, server: profile, port, passkeyStore: browser.passkeys[profile], owner: browser.owner });
};
