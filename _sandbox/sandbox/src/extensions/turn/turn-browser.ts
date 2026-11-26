import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    EXTENSION_BROWSER_TOOLS,
    type ExtensionBrowserCall,
    ExtensionNavigateArgumentsSchema,
    type ExtensionToolResult,
    ExtensionToolResultSchema,
    type ToolGrantAccount,
} from "@intentic/sandbox-contract/extension-protocol";
import type { InProcessServer, RpcMessage } from "../../agent/tools/turn-mounts.js";
import { onAccountSite, siteHostOf } from "../../browser/tools/accounts-tools.js";
import { evaluated } from "../../browser/tools/evaluate-answer.js";

/* AN EXTENSION TOOL DRIVING AN ACCOUNT'S BROWSER (2026-11-26, extension API 2.55.0). `api.browser.call` reaches the
   signed-in browser router of the turn whose call it is (browser/tools/browser-router.ts), the one the agent's own
   `browser` tools reach, for an account that turn holds, so every guard the router keeps holds here too: the account
   resolved to its profile through the turn's manifest, a file a call writes placed on the artifacts shelf, a file://
   navigation refused, network answers screened. The extension is held tighter than the agent on two counts, since
   nobody reads what it does as it does it:
   - Only the page's own tools (the contract's EXTENSION_BROWSER_TOOLS). `browser_run_code_unsafe` runs in Playwright's process against the whole
     browser, every site's cookies included, and goes anywhere; the network tools carry a session's headers; the tab
     list names every site the profile has open; the router's own site kits are another extension's to move.
   - Only on the account's own sites: the hosts its sign-in and home pages are on, widened to its operator's sign-in
     family (accounts-tools.ts accountSites, the sites `type_credential` holds a page to). A navigation elsewhere is
     refused before it is sent; any other call first reads where the page is and is refused off those sites, since an
     account's browser is often an identity's, signed in to its mail and every other account born of it; and a call that
     leaves them (a link clicked, a redirect) has its answer withheld.
   Stored credentials never come this way: typing one is `type_credential`'s, on the `accounts` server, which no extension
   reaches, and the door masks every stored secret's value in what comes back (tool-turn-doors.ts). */

// The page tools an extension may call: the contract's one list, which the SDK's fake reads too.
const ALLOWED: ReadonlySet<string> = new Set(EXTENSION_BROWSER_TOOLS);

const NAVIGATE = "browser_navigate";

// A call's arguments, as the door's request carries them.
export type BrowserArguments = NonNullable<ExtensionBrowserCall["arguments"]>;
type ToolResultOf = ExtensionToolResult;

// What one call came to: the router's answer, or why the core refused it (`withheld`: it ran, its answer is not handed
// over).
export type ScopedBrowserAnswer =
    | { readonly result: ToolResultOf }
    | { readonly refusal: string; readonly withheld?: true };

// Where the account's current page is: on one of its sites, on no site at all (about:blank, a data: page, a browser's
// own error page, where nothing is signed in), on a site of somebody else's, or nowhere it could tell.
type PageSite = { readonly on: "site" | "none" } | { readonly on: "off"; readonly host: string } | { readonly on: "unknown"; readonly why: string };

// Each call its own id: the router maps a client's id to the backend call it became, to chase a cancellation.
const callOf = (account: string, name: string, args: BrowserArguments): RpcMessage => ({
    jsonrpc: "2.0",
    id: `extension-browser-${randomUUID()}`,
    method: "tools/call",
    // The account is the grant's, never the extension's to widen.
    params: { name, arguments: { ...args, account } },
});

const HrefSchema = z.string();

const pageSite = async (router: InProcessServer, account: ToolGrantAccount, signal: AbortSignal): Promise<PageSite> => {
    const answer = await router.handle(callOf(account.id, "browser_evaluate", { function: "() => location.href" }), signal);
    const read = answer === undefined ? { failure: "the browser gave no answer" } : evaluated(answer);
    if ("failure" in read) {
        return { on: "unknown", why: read.failure };
    }
    const href = HrefSchema.safeParse(read.value);
    if (!href.success) {
        return { on: "unknown", why: "the page did not say where it is" };
    }
    const host = siteHostOf(href.data);
    if (host === undefined) {
        return { on: "none" };
    }
    return onAccountSite(host, account.sites) ? { on: "site" } : { on: "off", host };
};

const sitesOf = (account: ToolGrantAccount): string => account.sites.join(" or ");

// Why a call may not run where the page is now, or undefined.
const placeRefusal = (account: ToolGrantAccount, where: PageSite): string | undefined => {
    switch (where.on) {
        case "site":
        case "none":
            return undefined;
        case "off":
            return `account "${account.id}"'s page is on ${where.host}, outside its sites (${sitesOf(account)}): navigate to one of them first. Nothing was done.`;
        case "unknown":
            return `could not tell where account "${account.id}"'s page is (${where.why}): navigate to one of its sites (${sitesOf(account)}) first. Nothing was done.`;
    }
};

// Why a navigation may not go where it asks, or undefined.
const navigationRefusal = (account: ToolGrantAccount, args: BrowserArguments): string | undefined => {
    const url = ExtensionNavigateArgumentsSchema.safeParse(args).data?.url;
    const host = url === undefined ? undefined : siteHostOf(url);
    if (host !== undefined && onAccountSite(host, account.sites)) {
        return undefined;
    }
    return `account "${account.id}" signs in on ${sitesOf(account)}; ${url === undefined ? "a navigation names a url" : `${url} is not on them`}. Nothing was sent.`;
};

// A JSON-RPC error the router answered (a cancelled call), as the tool result a reader of a result reads.
const asResult = (answer: RpcMessage | undefined): ToolResultOf => {
    const result = ExtensionToolResultSchema.safeParse(answer?.result);
    if (result.success) {
        return result.data;
    }
    const message = z.looseObject({ message: z.string() }).safeParse(answer?.error).data?.message ?? "the browser gave no answer";
    return { content: [{ type: "text", text: message }], isError: true };
};

/**
 * One call of an extension's tool to the turn's signed-in browser router for `account`, held to the page tools and the
 * account's own sites. `router` is the turn's own `browser` mount.
 */
export const scopedBrowserCall = async (
    router: InProcessServer,
    account: ToolGrantAccount,
    call: { readonly tool: string; readonly args: BrowserArguments },
    signal: AbortSignal,
): Promise<ScopedBrowserAnswer> => {
    if (!ALLOWED.has(call.tool)) {
        return { refusal: `${call.tool} is not a browser tool an extension may call; it may call ${EXTENSION_BROWSER_TOOLS.join(", ")}.` };
    }
    if (account.sites.length === 0) {
        return { refusal: `nothing on record names a site account "${account.id}" signs in on, so an extension drives its browser nowhere.` };
    }
    const before = call.tool === NAVIGATE ? navigationRefusal(account, call.args) : placeRefusal(account, await pageSite(router, account, signal));
    if (before !== undefined) {
        return { refusal: before };
    }
    const answer = await router.handle(callOf(account.id, call.tool, call.args), signal);
    const after = await pageSite(router, account, signal);
    if (after.on === "off") {
        return {
            refusal: `account "${account.id}"'s page went to ${after.host} during ${call.tool}, outside its sites (${sitesOf(account)}), so its answer is withheld: navigate back to one of them.`,
            withheld: true,
        };
    }
    return { result: asResult(answer) };
};
