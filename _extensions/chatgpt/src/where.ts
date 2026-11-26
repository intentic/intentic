import type { ToolCallGrants, ToolGrantAccount } from "@intentic/extension-api";
import { CHATGPT_SITE } from "./kit/chatgpt/index.js";

// WHERE A CALL RUNS (2026-11-26): the browser a ChatGPT call drives, read off what its turn holds. A sandbox account
// whose sites cover chatgpt.com (`account`, its own signed-in browser in the sandbox, nobody in front of it), or one of
// the person's own browsers the turn holds (`browser`, their Chrome or Edge through the extension they installed). The
// person's browser is never chosen for them: it is used only when named, since a sandbox account works unattended and
// borrows nobody's session. The daemon refuses anything outside the grants anyway; this says why in the agent's words.

export type Where =
    | { readonly kind: "account"; readonly account: ToolGrantAccount }
    | { readonly kind: "browser"; readonly browser: string }
    | { readonly kind: "refused"; readonly refusal: string };

export interface Named {
    readonly account?: string | undefined;
    readonly browser?: string | undefined;
}

// Whether an account's sites take in chatgpt.com: the site itself, or a parent domain of it.
const coversChatgpt = (sites: readonly string[]): boolean => sites.some((site) => CHATGPT_SITE.host === site || CHATGPT_SITE.host.endsWith(`.${site}`));

// The accounts this turn holds that are signed in on chatgpt.com.
export const chatgptAccounts = (grants: ToolCallGrants): ToolGrantAccount[] => grants.accounts.filter((account) => coversChatgpt(account.sites));

const quoted = (names: readonly string[]): string => names.map((name) => `"${name}"`).join(" or ");

const NO_GRANTS =
    "This call came without what its turn holds, so no browser could be chosen for it: the sandbox's daemon is older than this extension, or the call did not come through an agent's turn. Nothing was sent.";

const NO_ACCOUNT =
    "No account this turn holds is signed in on chatgpt.com, so no sandbox browser here can run ChatGPT. Nothing was sent. Ask the owner to connect a ChatGPT account to this sandbox (a browser account for chatgpt.com, or one opened through an identity with `mcp__accounts__open_account`) and sign it in: in that account's browser here, or by handing over the session from their own Chrome with that browser's `connect_site` on chatgpt.com.";

// What to say about the person's own browsers the turn holds, after a refusal that leaves them as the way on.
const ownBrowsersHint = (browsers: readonly string[]): string =>
    browsers.length === 0
        ? ""
        : ` To use ChatGPT in the person's own browser instead, pass \`browser\` ${quoted(browsers)}, when they asked for it or ChatGPT needs something only that browser has.`;

const accountOf = (grants: ToolCallGrants, named: string): Where => {
    const held = chatgptAccounts(grants);
    const found = held.find((account) => account.id === named);
    if (found !== undefined) {
        return { kind: "account", account: found };
    }
    if (held.length === 0) {
        return { kind: "refused", refusal: `${NO_ACCOUNT}${ownBrowsersHint(grants.browsers)}` };
    }
    const other = grants.accounts.some((account) => account.id === named);
    const why = other ? `Account "${named}" does not sign in on chatgpt.com.` : `This turn holds no account "${named}".`;
    return {
        kind: "refused",
        refusal: `${why} Nothing was sent. Pass \`account\` ${quoted(held.map((account) => account.id))}: ${held.length === 1 ? "the account" : "the accounts"} on chatgpt.com this turn holds.`,
    };
};

const browserOf = (grants: ToolCallGrants, named: string): Where => {
    if (grants.browsers.includes(named)) {
        return { kind: "browser", browser: named };
    }
    const held = grants.browsers.length === 0 ? "it holds none of the person's own browsers" : `it holds ${quoted(grants.browsers)}`;
    return { kind: "refused", refusal: `This turn holds no browser of the person's called "${named}": ${held}. Nothing was sent.` };
};

/** The browser a call names, or the one it may mean when it names none; a refusal saying what to pass otherwise. */
export const whereOf = (grants: ToolCallGrants | undefined, named: Named): Where => {
    if (grants === undefined) {
        return { kind: "refused", refusal: NO_GRANTS };
    }
    if (named.account !== undefined && named.browser !== undefined) {
        return { kind: "refused", refusal: "Pass `account` (a sandbox account's browser) or `browser` (the person's own), not both. Nothing was sent." };
    }
    if (named.browser !== undefined) {
        return browserOf(grants, named.browser);
    }
    if (named.account !== undefined) {
        return accountOf(grants, named.account);
    }
    const held = chatgptAccounts(grants);
    const [only] = held;
    if (held.length === 1 && only !== undefined) {
        return { kind: "account", account: only };
    }
    if (held.length > 1) {
        return { kind: "refused", refusal: `Pass \`account\`: this turn holds several accounts on chatgpt.com, ${quoted(held.map((account) => account.id))}. Nothing was sent.` };
    }
    return { kind: "refused", refusal: `${NO_ACCOUNT}${ownBrowsersHint(grants.browsers)}` };
};
